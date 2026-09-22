#!/usr/bin/env bash
# Builds the production image in WSL, pushes it to GHCR, and rolls it out on the VM named in
# .env.deploy:
#
#   bash scripts/deploy.sh             # deploy the commit at HEAD
#   bash scripts/deploy.sh --dry-run   # print every command, image tags included, and run none
#
# Steps, each named when it fails: check the VM; `docker build --platform linux/amd64 --target
# production` with the PUBLIC_COMPLEX_NAME build arg from .env.deploy, tagged :<commit> and
# :latest; log in to GHCR with `gh auth token`; push both tags; copy docker-compose.prod.yml and
# Caddyfile to /opt/komplek when they differ; pull; set APP_TAG=<commit> in /opt/komplek/.env; up
# -d --remove-orphans; wait for migrate to exit 0; restart caddy if its Caddyfile changed; then
# `curl --fail https://<ip>.sslip.io/api/health`, retried for 90 seconds.
#
# The dry run runs git (rev-parse, status) and nothing else: no docker, gh, ssh, scp or curl.
#
# The one secret this script touches is the GitHub token from `gh auth token`. It is never held in
# a variable or passed as an argument: it goes through a pipe into `docker login --password-stdin`,
# and docker keeps it in a DOCKER_CONFIG directory made for this run (mode 700, on tmpfs when
# XDG_RUNTIME_DIR exists) and removed right after the push or on any exit, so it never lands in
# ~/.docker/config.json. The script never reads the VM's .env back: the one edit it makes there,
# APP_TAG, happens on the VM under umask 077.

if [ -z "${BASH_VERSION:-}" ]; then
	echo 'Jalankan dengan bash, bukan sh: bash scripts/deploy.sh' >&2
	exit 1
fi
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
readonly ROOT
readonly IMAGE=ghcr.io/jefrykurniaone/sistem-informasi-manajemen-keuangan
readonly REGISTRY=ghcr.io
readonly REGISTRY_USER=jefrykurniaone
readonly SOURCE_URL=https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan
readonly REMOTE_DIR=/opt/komplek
readonly COMPOSE='docker compose -f docker-compose.prod.yml'
readonly -a SYNCED_FILES=(docker-compose.prod.yml Caddyfile)
readonly HEALTH_SECONDS=90
readonly HEALTH_INTERVAL=5

readonly HOST_PATTERN='^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
readonly USER_PATTERN='^[a-z_][a-z0-9_-]*$'
readonly IPV4_PATTERN='^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$'
readonly PLAIN_WORD_PATTERN='^[A-Za-z0-9_@%+=:,./-]+$'

# The .env.deploy settings, cleared so a leftover in the environment is never taken for one.
unset VM_HOST VM_USER VM_SSH_KEY VM_STATIC_IP PUBLIC_COMPLEX_NAME

dry_run=0
commit=''
tag=''
target=''
ssh_cmd=()
scp_opts=()
git_cmd=()
docker_config=''
caddyfile_changed=0
step_number=0
current_step=''
step_hint=''

say() { printf '%s\n' "$*"; }
warn() { printf 'PERINGATAN: %s\n' "$*" >&2; }
die() {
	printf 'GAGAL: %s\n' "$*" >&2
	exit 1
}

usage() {
	say 'Pemakaian: bash scripts/deploy.sh [--dry-run]'
	say ''
	say 'Membangun image produksi dari commit HEAD, mendorongnya ke GHCR dengan tag SHA commit dan'
	say 'latest, lalu menjalankannya di VM yang disebut .env.deploy dan memeriksa /api/health.'
	say ''
	say '  --dry-run   cetak setiap perintah, termasuk tag image, tanpa menjalankannya. Tidak'
	say '              menjalankan docker, gh, ssh, scp, atau curl.'
}

parse_args() {
	local arg
	for arg in "$@"; do
		case $arg in
		--dry-run) dry_run=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		*) die 'argumen tidak dikenal; lihat --help.' ;;
		esac
	done
}

# Reads NAME=value lines from .env.deploy as data. Sourcing the file would run whatever it holds.
# Kept identical in scripts/setup-env.sh and scripts/deploy.sh.
load_deploy_env() {
	local file=$1 line key value number=0
	[[ -f $file ]] || die "$file belum ada. Salin .env.deploy.example ke .env.deploy lalu isi."
	while IFS= read -r line || [[ -n $line ]]; do
		number=$((number + 1))
		line=${line%$'\r'}
		line=${line#"${line%%[![:space:]]*}"}
		if [[ -z $line || $line == '#'* ]]; then
			continue
		fi
		line=${line#export }
		[[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || die ".env.deploy baris $number bukan NAMA=nilai."
		key=${BASH_REMATCH[1]}
		value=${BASH_REMATCH[2]}
		value=${value%"${value##*[![:space:]]}"}
		case $key in
		VM_HOST | VM_USER | VM_SSH_KEY | VM_STATIC_IP | PUBLIC_COMPLEX_NAME) ;;
		*) die ".env.deploy baris $number: $key tidak dikenal." ;;
		esac
		if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then
			value=${BASH_REMATCH[1]}
		fi
		printf -v "$key" '%s' "$value"
	done <"$file"
	if [[ ${VM_SSH_KEY:-} == \~/* ]]; then
		VM_SSH_KEY="$HOME/${VM_SSH_KEY#\~/}"
	fi
}

is_ipv4() {
	local part
	[[ $1 =~ $IPV4_PATTERN ]] || return 1
	for part in "${BASH_REMATCH[@]:1}"; do
		((part <= 255)) || return 1
	done
	return 0
}

check_deploy_env() {
	[[ ${VM_HOST:-} =~ $HOST_PATTERN ]] || die 'VM_HOST di .env.deploy kosong atau bukan nama host atau IP.'
	[[ ${VM_USER:-} =~ $USER_PATTERN ]] || die 'VM_USER di .env.deploy kosong atau bukan nama pengguna.'
	[[ -n ${VM_SSH_KEY:-} ]] || die 'VM_SSH_KEY di .env.deploy kosong.'
	is_ipv4 "${VM_STATIC_IP:-}" || die 'VM_STATIC_IP di .env.deploy harus alamat IPv4, misalnya 203.0.113.10.'
	[[ -n ${PUBLIC_COMPLEX_NAME:-} ]] ||
		die 'PUBLIC_COMPLEX_NAME di .env.deploy kosong; nama itu dibekukan ke image saat build.'
	target="$VM_USER@$VM_HOST"
	scp_opts=(-i "$VM_SSH_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=15)
	ssh_cmd=(ssh "${scp_opts[@]}" "$target")
}

check_tools() {
	local tool missing=() needed=(git)
	if ((!dry_run)); then
		needed+=(docker gh ssh scp curl sha256sum mktemp realpath)
	fi
	for tool in "${needed[@]}"; do
		command -v "$tool" >/dev/null || missing+=("$tool")
	done
	((${#missing[@]} == 0)) || die "tidak ditemukan di WSL: ${missing[*]}."
}

# git in WSL cannot follow a worktree made by Git for Windows, whose .git file names the repository
# as D:/..., so that path is translated with wslpath. GIT_OPTIONAL_LOCKS=0 keeps `git status` from
# rewriting the index, which a read-only check has no business doing.
setup_git() {
	local line='' gitdir
	git_cmd=(env GIT_OPTIONAL_LOCKS=0 git -C "$ROOT")
	if [[ -f $ROOT/.git ]] && ! "${git_cmd[@]}" rev-parse --git-dir >/dev/null 2>&1; then
		IFS= read -r line <"$ROOT/.git" || true
		line=${line%$'\r'}
		gitdir=${line#gitdir: }
		if [[ $gitdir =~ ^[A-Za-z]:[/\\] ]] && command -v wslpath >/dev/null; then
			git_cmd=(env GIT_OPTIONAL_LOCKS=0 git -C "$ROOT" --git-dir="$(wslpath -u "$gitdir")" --work-tree="$ROOT")
		fi
	fi
	"${git_cmd[@]}" rev-parse --git-dir >/dev/null 2>&1 || die "$ROOT tidak terbaca sebagai repositori git."
}

resolve_tag() {
	commit=$("${git_cmd[@]}" rev-parse HEAD) || die 'commit HEAD tidak terbaca.'
	tag=$("${git_cmd[@]}" rev-parse --short=12 HEAD) || die 'commit HEAD tidak terbaca.'
	[[ $tag =~ ^[0-9a-f]{12,40}$ ]] || die 'SHA commit HEAD tidak berbentuk heksadesimal.'
}

check_clean_tree() {
	local changes
	changes=$("${git_cmd[@]}" status --porcelain) || die 'git status gagal.'
	if [[ -z $changes ]]; then
		return 0
	fi
	if ((dry_run)); then
		warn "pohon kerja tidak bersih. Deploy sungguhan berhenti di sini, karena image bertag $tag harus dibangun dari commit itu apa adanya."
	else
		die "pohon kerja tidak bersih. Image bertag $tag harus dibangun dari commit itu apa adanya: commit atau stash perubahan dulu."
	fi
}

check_ssh_key() {
	local mode real problem=''
	if [[ ! -f $VM_SSH_KEY || ! -r $VM_SSH_KEY ]]; then
		problem="kunci SSH $VM_SSH_KEY tidak ada atau tidak terbaca."
	else
		mode=$(stat -c %a -- "$VM_SSH_KEY")
		real=$(realpath -m -- "$VM_SSH_KEY")
		if ((8#$mode & 8#077)); then
			problem="kunci SSH $VM_SSH_KEY bermode $mode, dan ssh menolak kunci yang bisa dibaca pengguna lain. Jalankan chmod 600 padanya; di /mnt/c atau /mnt/d mode tidak bisa diubah, jadi salin kuncinya ke ~/.ssh di WSL."
		elif [[ $real == "$ROOT"/* ]]; then
			# .gitignore keeps *.pem out of git, but docker build sends the whole tree as its context
			# and .dockerignore does not filter *.pem, so the build stage's `COPY . .` would take it.
			problem="kunci SSH $VM_SSH_KEY ada di dalam repositori. docker build mengirim seluruh repositori sebagai konteks build; pindahkan kunci ke ~/.ssh di WSL."
		fi
	fi
	if [[ -z $problem ]]; then
		return 0
	fi
	if ((dry_run)); then
		warn "$problem Dry-run tetap lanjut."
	else
		die "$problem"
	fi
}

# Formats a command as it would be typed, quoting only the words that need it. Nothing this script
# prints holds a secret.
format_cmd() {
	local arg out=''
	for arg in "$@"; do
		if [[ $arg =~ $PLAIN_WORD_PATTERN ]]; then
			out+=" $arg"
		else
			out+=" ${arg@Q}"
		fi
	done
	printf '%s' "${out# }"
}

print_cmd() {
	printf '+ %s\n' "$(format_cmd "$@")"
}

# Prints a command, then runs it unless this is a dry run. Standard input is closed: nothing run
# here needs it, and ssh would otherwise forward whatever the terminal holds.
run() {
	print_cmd "$@"
	if ((dry_run)); then
		return 0
	fi
	"$@" </dev/null
}

step() {
	step_number=$((step_number + 1))
	current_step=$1
	step_hint=${2:-}
	say ''
	say "==> Langkah $step_number: $current_step"
}

on_exit() {
	local status=$?
	remove_docker_config
	if ((status != 0)) && [[ -n $current_step ]]; then
		printf '\nGAGAL: deploy berhenti di langkah %d, "%s" (kode %d).\n' "$step_number" "$current_step" "$status" >&2
		if [[ -n $step_hint ]]; then
			printf '%s\n' "$step_hint" >&2
		fi
	fi
	exit "$status"
}

print_plan() {
	say "Deploy $IMAGE"
	say "  commit        $commit"
	say "  tag image     $IMAGE:$tag"
	say "                $IMAGE:latest"
	say "  nama komplek  $PUBLIC_COMPLEX_NAME (build arg PUBLIC_COMPLEX_NAME)"
	say "  VM            $target:$REMOTE_DIR"
	say "  alamat        https://$VM_STATIC_IP.sslip.io"
	if ((dry_run)); then
		say '  mode          dry-run: setiap perintah dicetak, tidak satu pun dijalankan'
	fi
}

# The vm_* functions run on the VM, never here: run_on_vm sends a function's definition and its
# call to `bash -s` over ssh, so nothing needs quoting and nothing is left on the VM. They take the
# app directory as $1, since this script's variables do not exist over there.
run_on_vm() {
	local call
	call=$(format_cmd "$@")
	printf '+ { declare -f %s; echo %s; } | %s bash -s\n' "$1" "${call@Q}" "$(format_cmd "${ssh_cmd[@]}")"
	if ((dry_run)); then
		return 0
	fi
	{
		declare -f "$1"
		printf '%s\n' "$call"
	} | "${ssh_cmd[@]}" bash -s
}

vm_preflight() {
	cd "$1" 2>/dev/null || {
		echo "$1 belum ada. Jalankan scripts/bootstrap-vm.sh di VM." >&2
		return 1
	}
	if [ ! -f .env ]; then
		echo "$1/.env belum ada. Jalankan scripts/setup-env.sh." >&2
		return 1
	fi
	if ! docker info >/dev/null 2>&1; then
		echo "$(id -un) belum bisa memakai docker. Jalankan scripts/bootstrap-vm.sh, lalu keluar dan masuk lagi SSH." >&2
		return 1
	fi
	if ! docker compose version >/dev/null 2>&1; then
		echo 'Plugin docker compose belum terpasang. Jalankan scripts/bootstrap-vm.sh.' >&2
		return 1
	fi
	# Reads only whether the line matches; nothing of .env is printed.
	if grep -q '^DATABASE_URL=.*sslrootcert=/app/certs/supabase-ca\.crt' .env && [ ! -s certs/supabase-ca.crt ]; then
		echo "DATABASE_URL memakai sslrootcert, tetapi $1/certs/supabase-ca.crt belum ada. Jalankan scripts/setup-env.sh dengan jalur CA Supabase, atau salin CA itu ke sana." >&2
		return 1
	fi
	echo '  VM siap'
}

# Rewrites the APP_TAG line of .env. .env.next is created fresh under umask 077 and noclobber, so it
# is 600 from the moment it exists, and replaces .env only once it is complete.
vm_set_app_tag() {
	cd "$1" || return 1
	umask 077
	set -C
	rm -f .env.next
	if awk -v tag="$2" '
		/^APP_TAG=/ { print "APP_TAG=" tag; found = 1; next }
		{ print }
		END { if (!found) print "APP_TAG=" tag }
	' .env >.env.next && mv -f .env.next .env; then
		echo "  APP_TAG=$2 di $1/.env"
	else
		rm -f .env.next
		return 1
	fi
}

vm_migrate_status() {
	local id code
	cd "$1" || return 1
	id=$(docker compose -f docker-compose.prod.yml ps --all --quiet migrate) || return 1
	id=${id%%$'\n'*}
	if [ -z "$id" ]; then
		echo 'Container migrate tidak ditemukan.' >&2
		return 1
	fi
	code=$(timeout 600 docker wait "$id") || return 1
	if [ "$code" != 0 ]; then
		echo "migrate keluar dengan kode $code." >&2
		return 1
	fi
	echo '  migrate keluar 0'
}

shown_docker_config() {
	printf '%s' "${docker_config:-<direktori-sementara>}"
}

login_ghcr() {
	local base=${XDG_RUNTIME_DIR:-}
	if [[ -z $base || ! -d $base || ! -w $base ]]; then
		base=${TMPDIR:-/tmp}
	fi
	print_cmd mktemp -d "$base/komplek-ghcr.XXXXXX"
	if ((!dry_run)); then
		docker_config=$(mktemp -d "$base/komplek-ghcr.XXXXXX")
	fi
	printf '+ gh auth token --hostname github.com | %s\n' \
		"$(format_cmd env "DOCKER_CONFIG=$(shown_docker_config)" docker login "$REGISTRY" --username "$REGISTRY_USER" --password-stdin)"
	if ((dry_run)); then
		return 0
	fi
	gh auth token --hostname github.com |
		env "DOCKER_CONFIG=$docker_config" docker login "$REGISTRY" --username "$REGISTRY_USER" --password-stdin
}

push_image() {
	run env "DOCKER_CONFIG=$(shown_docker_config)" docker push "$1"
}

remove_docker_config() {
	if [[ -n $docker_config ]]; then
		print_cmd rm -rf -- "$docker_config"
		rm -rf -- "$docker_config"
		docker_config=''
	fi
}

sync_files() {
	local remote_sums file local_sum
	local hash_cmd="cd $REMOTE_DIR && { sha256sum -- ${SYNCED_FILES[*]} 2>/dev/null || true; }"
	caddyfile_changed=0
	print_cmd "${ssh_cmd[@]}" "$hash_cmd"
	if ((dry_run)); then
		say '  (dry-run: hash di VM tidak dibaca. Berkas yang hash-nya berbeda dari salinan lokal disalin dengan:)'
		for file in "${SYNCED_FILES[@]}"; do
			print_cmd scp "${scp_opts[@]}" -- "$ROOT/$file" "$target:$REMOTE_DIR/$file"
		done
		return 0
	fi
	remote_sums=$("${ssh_cmd[@]}" "$hash_cmd" </dev/null)
	for file in "${SYNCED_FILES[@]}"; do
		local_sum=$(cd "$ROOT" && sha256sum -- "$file")
		if [[ $'\n'$remote_sums$'\n' == *$'\n'"$local_sum"$'\n'* ]]; then
			say "  $file sama dengan di VM, tidak disalin"
		else
			run scp "${scp_opts[@]}" -- "$ROOT/$file" "$target:$REMOTE_DIR/$file"
			if [[ $file == Caddyfile ]]; then
				caddyfile_changed=1
			fi
		fi
	done
}

compose_up() {
	if run "${ssh_cmd[@]}" "cd $REMOTE_DIR && $COMPOSE up -d --remove-orphans"; then
		return 0
	fi
	say '  up gagal. Status migrate:'
	run_on_vm vm_migrate_status "$REMOTE_DIR" || true
	return 1
}

health_check() {
	local url="https://$VM_STATIC_IP.sslip.io/api/health" attempt=0 deadline
	print_cmd curl --fail --silent --show-error --max-time 10 --output /dev/null "$url"
	say "  (diulang tiap $HEALTH_INTERVAL detik sampai $HEALTH_SECONDS detik)"
	if ((dry_run)); then
		return 0
	fi
	deadline=$((SECONDS + HEALTH_SECONDS))
	while true; do
		attempt=$((attempt + 1))
		if curl --fail --silent --show-error --max-time 10 --output /dev/null "$url"; then
			say "  sehat pada percobaan $attempt"
			return 0
		fi
		if ((SECONDS >= deadline)); then
			return 1
		fi
		say "  percobaan $attempt belum berhasil; ulang dalam $HEALTH_INTERVAL detik"
		sleep "$HEALTH_INTERVAL"
	done
}

main() {
	local logs_hint
	parse_args "$@"
	trap on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM

	load_deploy_env "$ROOT/.env.deploy"
	check_deploy_env
	check_tools
	setup_git
	resolve_tag
	check_clean_tree
	check_ssh_key
	print_plan
	logs_hint="Log di VM: $(format_cmd "${ssh_cmd[@]}" "cd $REMOTE_DIR && $COMPOSE logs migrate app caddy")"

	step 'periksa VM' 'Jalankan scripts/bootstrap-vm.sh di VM, lalu scripts/setup-env.sh di sini, bila belum.'
	run_on_vm vm_preflight "$REMOTE_DIR"

	# --network host: on the WSL daemon the default bridge network stalls during layer extraction
	# (found while verifying #172).
	step 'build image' 'Periksa keluaran docker build di atas; daemon Docker di WSL harus menyala.'
	run docker build --network host --platform linux/amd64 --target production \
		--build-arg "PUBLIC_COMPLEX_NAME=$PUBLIC_COMPLEX_NAME" \
		--label "org.opencontainers.image.source=$SOURCE_URL" \
		--label "org.opencontainers.image.revision=$commit" \
		--tag "$IMAGE:$tag" --tag "$IMAGE:latest" "$ROOT"

	step 'login GHCR' 'gh harus terpasang di WSL dan sudah masuk: gh auth login.'
	login_ghcr

	step "push $IMAGE:$tag" 'Token gh butuh cakupan write:packages: gh auth refresh --scopes write:packages, lalu ulangi.'
	push_image "$IMAGE:$tag"
	step "push $IMAGE:latest" 'Token gh butuh cakupan write:packages: gh auth refresh --scopes write:packages, lalu ulangi.'
	push_image "$IMAGE:latest"
	if ((dry_run)); then
		print_cmd rm -rf -- "$(shown_docker_config)"
	fi
	remove_docker_config

	step 'salin docker-compose.prod.yml dan Caddyfile bila berubah' ''
	sync_files

	step "pull image $tag di VM" 'Paket GHCR sistem-informasi-manajemen-keuangan harus publik supaya VM bisa menarik tanpa login: GitHub, Packages, Package settings, Change visibility.'
	run "${ssh_cmd[@]}" "cd $REMOTE_DIR && APP_TAG=$tag $COMPOSE pull"

	step "set APP_TAG=$tag di $REMOTE_DIR/.env" ''
	run_on_vm vm_set_app_tag "$REMOTE_DIR" "$tag"

	step 'up -d --remove-orphans' "$logs_hint"
	compose_up

	step 'tunggu migrate keluar 0' "$logs_hint"
	run_on_vm vm_migrate_status "$REMOTE_DIR"

	if ((dry_run || caddyfile_changed)); then
		step 'mulai ulang caddy karena Caddyfile berubah' "$logs_hint"
		if ((dry_run)); then
			say '  (dry-run: hanya dijalankan bila Caddyfile disalin pada langkah salin)'
		fi
		run "${ssh_cmd[@]}" "cd $REMOTE_DIR && $COMPOSE restart caddy"
	fi

	step "health check https://$VM_STATIC_IP.sslip.io/api/health" "Pastikan TCP 80 dan 443 terbuka di firewall Lightsail supaya Caddy mendapat sertifikat. $logs_hint"
	health_check

	current_step=''
	say ''
	if ((dry_run)); then
		say 'Dry-run selesai. Tidak ada perintah yang dijalankan.'
	else
		say "Deploy selesai: https://$VM_STATIC_IP.sslip.io menjalankan $IMAGE:$tag."
	fi
}

main "$@"
