#!/usr/bin/env bash
# Interactive wizard for the server's .env, run from WSL on the developer machine once
# scripts/bootstrap-vm.sh has prepared the VM:
#
#   bash scripts/setup-env.sh              # asks, then writes /opt/komplek/.env on the VM
#   DRY_RUN=1 bash scripts/setup-env.sh    # asks the same questions, prints only variable names
#                                          # and the commands it would run, contacts nothing
#
# It reads the VM's SSH host, SSH user, key path and static IP from .env.deploy, asks for every
# variable of .env.production.example in that file's order, generates BETTER_AUTH_SECRET and
# FILE_STORE_SECRET with `openssl rand -base64 32` when left empty, derives SITE_ADDRESS and ORIGIN
# from the static IP (<ip>.sslip.io), and writes the result to /opt/komplek/.env with mode 600. It
# also copies docker-compose.prod.yml and Caddyfile to /opt/komplek and, when a path is given, the
# Supabase CA certificate to /opt/komplek/certs/supabase-ca.crt. Answers are read from standard
# input, one per line, so a dry run can be fed through a pipe.
#
# Where a value can go and where it cannot. Keep every property below when editing:
#
# - Never printed. The script prints literals, variable names, paths and the VM address from
#   .env.deploy, never a value it read, generated or derived. A message about a bad value describes
#   the rule, not the value. The name lists come from list_names, which prints only the part of each
#   rendered line before the `=`.
# - Never in a local file. Values live in the ENV_VALUES array in this process's memory. No heredoc
#   or here-string carries one, because bash may back those with a temporary file.
# - Never in an argument list. Values reach the VM on the standard input of ssh, rendered by the
#   printf builtin (a builtin starts no program, so nothing reaches /proc/<pid>/cmdline), and the
#   remote command is a constant. openssl only writes a value to its standard output, a pipe back
#   into this process. print_cmd and run are only ever given commands that hold no value.
# - Never in a child's environment. ENV_VALUES is an associative array, which bash cannot export,
#   the scratch variables are `local` (created unexported), and allexport is switched off below.
# - Never traced. xtrace is switched off before anything else runs, so `bash -x` shows nothing past
#   that line. No value reaches eval or an arithmetic context, whose error messages quote operands.
# - Never in shell history. The script takes no value as an argument, answers are typed at `read`
#   rather than on a command line, and non-interactive bash keeps no history.
# - 600 from creation on the VM. The remote shell sets umask 077 and noclobber, removes a stale
#   .env.next, creates it fresh, checks that the end marker arrived, and only then renames it over
#   .env. A cut connection leaves the previous .env as it was.

if [ -z "${BASH_VERSION:-}" ]; then
	echo 'Jalankan dengan bash, bukan sh: bash scripts/setup-env.sh' >&2
	exit 1
fi
set +o xtrace +o verbose
set -euo pipefail
set +o allexport +o history

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
readonly ROOT
readonly DEPLOY_ENV_FILE="$ROOT/.env.deploy"
readonly EXAMPLE_FILE="$ROOT/.env.production.example"
readonly REMOTE_DIR=/opt/komplek
readonly END_MARKER='# Akhir berkas, ditulis scripts/setup-env.sh'

readonly HOST_PATTERN='^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
readonly USER_PATTERN='^[a-z_][a-z0-9_-]*$'
readonly IPV4_PATTERN='^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$'
readonly TAG_PATTERN='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
readonly SIZE_PATTERN='^([0-9]+[KMG]?|Infinity)$'
readonly PORT_PATTERN='^[0-9]{1,5}$'
readonly RELATIVE_PATH_PATTERN='^[A-Za-z0-9_][A-Za-z0-9_./-]*$'
readonly PLAIN_WORD_PATTERN='^[A-Za-z0-9_@%+=:,./-]+$'

# Run on the VM by the SSH user's login shell. Both are constants: no value is ever part of a
# command line, locally or on the VM.
readonly REMOTE_PREFLIGHT="cd $REMOTE_DIR 2>/dev/null || { echo no-dir; exit 0; }; [ -w . ] || echo not-writable; [ -d certs ] || echo no-certs; [ -d storage ] || echo no-storage; [ -e .env ] && echo has-env; [ -s certs/supabase-ca.crt ] && echo has-ca; exit 0"
readonly REMOTE_WRITE_ENV="umask 077 && set -C && cd $REMOTE_DIR && rm -f .env.next && { cat >.env.next && tail -n 1 .env.next | grep -qxF '$END_MARKER' && mv -f .env.next .env || { rm -f .env.next; exit 1; }; } && stat -c %a .env"

# Every value of the server's .env, by name. An associative array, which bash never exports, so no
# child process inherits a value. Unset first in case the name arrived through the environment.
unset ENV_VALUES
declare -A ENV_VALUES=()
# The names of .env.production.example, in that file's order.
KEYS=()
# The .env.deploy settings, cleared so a leftover in the environment is never taken for one.
unset VM_HOST VM_USER VM_SSH_KEY VM_STATIC_IP PUBLIC_COMPLEX_NAME

dry_run=0
scp_opts=()
ssh_cmd=()
target=''
remote_state=''
ca_path=''
# Set by describe().
kind=''
default=''
help=''

say() { printf '%s\n' "$*"; }
warn() { printf 'PERINGATAN: %s\n' "$*" >&2; }
die() {
	printf 'GAGAL: %s\n' "$*" >&2
	exit 1
}

usage() {
	say 'Pemakaian: bash scripts/setup-env.sh [--dry-run]'
	say ''
	say 'Menanyakan setiap variabel .env.production.example lalu menulis /opt/komplek/.env di VM'
	say '(mode 600) dan menyalin docker-compose.prod.yml serta Caddyfile ke /opt/komplek. Alamat VM'
	say 'dibaca dari .env.deploy. Jawaban dibaca dari masukan standar, satu per baris.'
	say ''
	say '  --dry-run, DRY_RUN=1   pertanyaan yang sama, tetapi hanya nama variabel dan perintah yang'
	say '                         dicetak; tidak ada yang dikirim ke VM.'
}

parse_args() {
	local arg
	case ${DRY_RUN:-} in
	'' | 0) ;;
	*) dry_run=1 ;;
	esac
	for arg in "$@"; do
		case $arg in
		--dry-run) dry_run=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		# Not echoed back: this script never takes a value as an argument, and one typed there by
		# mistake should not land on the screen as well.
		*) die 'argumen tidak dikenal. Skrip ini tidak menerima nilai lewat argumen; lihat --help.' ;;
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
	target="$VM_USER@$VM_HOST"
	scp_opts=(-i "$VM_SSH_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=15)
	ssh_cmd=(ssh "${scp_opts[@]}" "$target")
}

check_ssh_key() {
	local mode problem=''
	if [[ ! -f $VM_SSH_KEY || ! -r $VM_SSH_KEY ]]; then
		problem="kunci SSH $VM_SSH_KEY tidak ada atau tidak terbaca."
	else
		mode=$(stat -c %a -- "$VM_SSH_KEY")
		if ((8#$mode & 8#077)); then
			problem="kunci SSH $VM_SSH_KEY bermode $mode, dan ssh menolak kunci yang bisa dibaca pengguna lain. Jalankan chmod 600 padanya; di /mnt/c atau /mnt/d mode tidak bisa diubah, jadi salin kuncinya ke ~/.ssh di WSL."
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

# Sets kind, default and help for one variable of .env.production.example. An unknown name fails,
# so a variable added to that file is never silently missing from the server's .env.
describe() {
	default=''
	case $1 in
	APP_TAG)
		kind=text default=latest
		help='Tag image ghcr.io/jefrykurniaone/sistem-informasi-manajemen-keuangan yang dijalankan migrate dan app. deploy.sh menggantinya dengan SHA commit pada setiap deploy.'
		;;
	SITE_ADDRESS)
		kind=site_address
		help='Nama host yang dilayani Caddy dan diberi sertifikat TLS: <ip>.sslip.io.'
		;;
	ORIGIN)
		kind=origin
		help='Alamat aplikasi, dipakai memeriksa kiriman form dan membangun tautan di email: https://<ip>.sslip.io.'
		;;
	BODY_SIZE_LIMIT)
		kind=text default=16M
		help='Batas ukuran badan permintaan di adapter-node, di atas tiga kali batas unggah per berkas.'
		;;
	DATABASE_URL)
		kind=database_url
		help='URL session pooler Supabase (port 5432) yang diakhiri ?sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt. Rahasia: tidak tampil saat diketik atau ditempel.'
		;;
	BETTER_AUTH_SECRET)
		kind=generated_secret
		help='Penanda tangan sesi dan tautan verifikasi, minimal 32 karakter. Enter untuk membuatnya dengan openssl rand -base64 32. Rahasia: tidak tampil saat diketik.'
		;;
	FILE_STORE_ROOT)
		kind=text default=storage
		help='Direktori berkas unggahan, relatif terhadap /app di container. docker-compose.prod.yml memasang /opt/komplek/storage di /app/storage, jadi biarkan storage.'
		;;
	FILE_STORE_SECRET)
		kind=generated_secret
		help='Penanda tangan tautan unduh berkas, minimal 32 karakter dan berbeda dari BETTER_AUTH_SECRET. Enter untuk membuatnya dengan openssl rand -base64 32. Rahasia: tidak tampil saat diketik.'
		;;
	SMTP_HOST)
		kind=text default=smtp.gmail.com
		help='Server SMTP penyedia email.'
		;;
	SMTP_PORT)
		kind=text default=587
		help='Port submission SMTP. Koneksi dinaikkan ke TLS dengan STARTTLS.'
		;;
	SMTP_USER)
		kind=optional
		help='Login SMTP; untuk Gmail, alamat Gmail lengkap. Kosongkan hanya bila server SMTP tidak memakai login, dan SMTP_PASS lalu ikut kosong.'
		;;
	SMTP_PASS)
		kind=smtp_pass
		help='Kata sandi SMTP; untuk Gmail, app password 16 huruf tanpa spasi. Rahasia: dibaca tanpa echo.'
		;;
	EMAIL_FROM)
		kind=email_from
		help='Pengirim setiap email, misalnya "Nama Komplek <alamat@gmail.com>". Enter untuk PUBLIC_COMPLEX_NAME dari .env.deploy diikuti <SMTP_USER>.'
		;;
	*) return 1 ;;
	esac
}

read_example_keys() {
	local line key
	[[ -f $EXAMPLE_FILE ]] || die ".env.production.example tidak ditemukan di $ROOT."
	while IFS= read -r line || [[ -n $line ]]; do
		line=${line%$'\r'}
		if [[ $line =~ ^([A-Z_][A-Z0-9_]*)= ]]; then
			key=${BASH_REMATCH[1]}
			describe "$key" ||
				die ".env.production.example memuat $key, yang belum dikenal wizard ini. Tambahkan penanganannya di describe() pada scripts/setup-env.sh."
			KEYS+=("$key")
		fi
	done <"$EXAMPLE_FILE"
	((${#KEYS[@]} > 0)) || die '.env.production.example tidak memuat satu variabel pun.'
}

# Formats a command as it would be typed, quoting only the words that need it. Only ever given
# commands that hold no value.
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

# Prints a command, then runs it unless this is a dry run. Standard input is closed so that ssh or
# scp can never swallow the answers still waiting on this script's input.
run() {
	print_cmd "$@"
	if ((dry_run)); then
		return 0
	fi
	"$@" </dev/null
}

has_state() {
	[[ $'\n'$remote_state$'\n' == *$'\n'"$1"$'\n'* ]]
}

confirm() {
	local reply
	printf '  Ketik %s untuk melanjutkan, apa pun selain itu membatalkan: ' "$1"
	IFS= read -r reply || die 'masukan berakhir; dibatalkan, tidak ada yang ditulis ke VM.'
	[[ -t 0 ]] || printf '\n'
	[[ $reply == "$1" ]] || die 'dibatalkan; tidak ada yang ditulis ke VM.'
}

preflight_vm() {
	say ''
	say "Memeriksa VM $target"
	print_cmd "${ssh_cmd[@]}" "$REMOTE_PREFLIGHT"
	if ((dry_run)); then
		say '  (dry-run: tidak dijalankan)'
		return 0
	fi
	remote_state=$("${ssh_cmd[@]}" "$REMOTE_PREFLIGHT" </dev/null) ||
		die "tidak bisa masuk ke $target lewat ssh. Periksa VM_HOST, VM_USER, VM_SSH_KEY, dan port 22 di firewall Lightsail."
	if has_state no-dir; then
		die "$REMOTE_DIR belum ada di VM. Jalankan scripts/bootstrap-vm.sh di VM dulu."
	fi
	if has_state not-writable; then
		die "$REMOTE_DIR tidak bisa ditulis $VM_USER. Jalankan scripts/bootstrap-vm.sh sebagai $VM_USER."
	fi
	if has_state no-certs || has_state no-storage; then
		die "$REMOTE_DIR/certs atau $REMOTE_DIR/storage belum ada. Jalankan scripts/bootstrap-vm.sh di VM."
	fi
	say '  VM siap'
	if has_state has-env; then
		warn "$REMOTE_DIR/.env sudah ada dan akan diganti seluruhnya. BETTER_AUTH_SECRET yang baru mengeluarkan semua sesi yang sedang masuk, dan FILE_STORE_SECRET yang baru membatalkan tautan unduh yang sudah dibagikan."
		confirm ganti
	fi
}

# Reads one answer into the caller's `answer` (bash scoping is dynamic), without echo for a secret.
# The end of input stops the wizard instead of looping, which matters when answers come from a pipe.
read_answer() {
	local key=$1 hidden=$2
	if ((hidden)); then
		printf '  > (tidak ditampilkan) '
		IFS= read -r -s answer || die "masukan berakhir sebelum $key terisi."
		printf '\n'
	else
		printf '  > '
		IFS= read -r answer || die "masukan berakhir sebelum $key terisi."
		[[ -t 0 ]] || printf '\n'
	fi
}

# docker compose reads a single-quoted value literally: no ${...} interpolation, no inline comment.
# A single quote or a backslash cannot be carried reliably inside those quotes (compose-go treats a
# backslash before the closing quote as an escape), so either is refused rather than escaped.
check_quotable() {
	if [[ $answer == *"'"* || $answer == *\\* || $answer == *$'\r'* ]]; then
		problem="tidak boleh memuat tanda kutip tunggal ('), garis miring terbalik (\\), atau CR. Di dalam URL, tulis keduanya sebagai %27 dan %5C."
	fi
}

check_text() {
	case $1 in
	APP_TAG)
		[[ $answer =~ $TAG_PATTERN ]] ||
			problem='bukan tag image yang sah: huruf, angka, titik, garis bawah, atau tanda hubung, paling panjang 128.'
		;;
	BODY_SIZE_LIMIT)
		[[ $answer =~ $SIZE_PATTERN ]] || problem='harus angka dengan akhiran K, M, atau G, atau Infinity.'
		;;
	FILE_STORE_ROOT)
		if [[ ! $answer =~ $RELATIVE_PATH_PATTERN ]]; then
			problem='harus jalur relatif, misalnya storage.'
		elif [[ $answer != storage ]]; then
			warn 'selain storage, berkas unggahan jatuh di luar volume /opt/komplek/storage dan hilang bersama container.'
		fi
		;;
	SMTP_HOST)
		[[ $answer =~ $HOST_PATTERN ]] || problem='bukan nama host.'
		;;
	SMTP_PORT)
		if [[ ! $answer =~ $PORT_PATTERN ]] || ((10#$answer < 1 || 10#$answer > 65535)); then
			problem='harus nomor port 1 sampai 65535.'
		fi
		;;
	*) ;;
	esac
}

check_database_url() {
	if [[ -z $answer ]]; then
		problem='wajib diisi.'
	elif [[ $answer != postgres://* && $answer != postgresql://* ]]; then
		problem='harus diawali postgres:// atau postgresql://.'
	elif [[ $answer == *PROJECT_REF* || $answer == *:PASSWORD@* || $answer == *REGION* ]]; then
		problem='masih memuat penanda contoh PROJECT_REF, PASSWORD, atau REGION dari .env.production.example.'
	elif [[ $answer == *:6543/* ]]; then
		problem='port 6543 adalah transaction pooler; aplikasi dan migrate memakai session pooler di port 5432.'
	elif [[ $answer == *sslmode=require* && $answer != *uselibpqcompat=true* ]]; then
		problem='sslmode=require saja ditolak pg 8.23 dengan SELF_SIGNED_CERT_IN_CHAIN. Pakai sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt, lihat .env.production.example.'
	elif [[ $answer != *sslrootcert=/app/certs/supabase-ca.crt* ]]; then
		warn 'DATABASE_URL tidak memakai sslrootcert=/app/certs/supabase-ca.crt. Pastikan itu disengaja; lihat .env.production.example.'
	fi
}

settle_generated_secret() {
	local other=BETTER_AUTH_SECRET
	if [[ $1 == BETTER_AUTH_SECRET ]]; then
		other=FILE_STORE_SECRET
	fi
	if [[ -z $answer ]]; then
		answer=$(openssl rand -base64 32) || die 'openssl rand gagal.'
		note='dibuat dengan openssl rand -base64 32'
	fi
	if ((${#answer} < 32)); then
		problem='minimal 32 karakter.'
	elif [[ $answer == "${ENV_VALUES[$other]-}" ]]; then
		problem="harus berbeda dari $other."
	fi
}

check_smtp_pass() {
	if [[ -z $answer ]]; then
		problem='wajib diisi karena SMTP_USER terisi.'
	elif [[ ${ENV_VALUES[SMTP_HOST]-} == smtp.gmail.com && $answer == *' '* ]]; then
		problem='app password Gmail tidak memuat spasi; ketik 16 hurufnya tanpa spasi.'
	fi
}

settle_email_from() {
	if [[ -z $answer ]]; then
		if [[ -n ${PUBLIC_COMPLEX_NAME:-} && -n ${ENV_VALUES[SMTP_USER]-} ]]; then
			answer="$PUBLIC_COMPLEX_NAME <${ENV_VALUES[SMTP_USER]}>"
			note='diisi dari PUBLIC_COMPLEX_NAME dan SMTP_USER'
		else
			problem='wajib diisi, karena PUBLIC_COMPLEX_NAME di .env.deploy atau SMTP_USER kosong.'
			return 0
		fi
	fi
	if [[ $answer != *@* ]]; then
		problem='harus memuat alamat email.'
	fi
}

# Turns the raw answer for $1 into the value to store, or says in `problem` why it cannot be one.
# Reads and writes the caller's `answer`, `problem` and `note`; never puts a value in a message.
settle() {
	local key=$1
	problem=''
	case $kind in
	text)
		if [[ -z $answer ]]; then
			answer=$default
		fi
		if [[ -z $answer ]]; then
			problem='wajib diisi.'
		else
			check_text "$key"
		fi
		;;
	optional) ;;
	database_url) check_database_url ;;
	generated_secret) settle_generated_secret "$key" ;;
	smtp_pass) check_smtp_pass ;;
	email_from) settle_email_from ;;
	*) die "jenis $kind untuk $key belum ditangani." ;;
	esac
	if [[ -z $problem ]]; then
		check_quotable
	fi
}

ask_value() {
	local key=$1 answer='' problem='' note='' hidden=0
	case $kind in
	database_url | generated_secret | smtp_pass) hidden=1 ;;
	*) ;;
	esac
	if [[ -n $default ]]; then
		say "  Enter untuk $default"
	fi
	while true; do
		read_answer "$key" "$hidden"
		note=''
		settle "$key"
		if [[ -z $problem ]]; then
			break
		fi
		warn "$key $problem Ulangi."
	done
	ENV_VALUES[$key]=$answer
	say "  ${note:-diterima}"
}

ask_all() {
	local total=${#KEYS[@]} index=0 key
	say ''
	say "Mengisi $total variabel dari .env.production.example. Nilai yang diisi tidak pernah ditampilkan kembali."
	for key in "${KEYS[@]}"; do
		index=$((index + 1))
		describe "$key"
		say ''
		say "[$index/$total] $key"
		say "  $help"
		case $kind in
		site_address)
			ENV_VALUES[$key]="$VM_STATIC_IP.sslip.io"
			say '  diturunkan dari VM_STATIC_IP, tidak ditanyakan'
			;;
		origin)
			ENV_VALUES[$key]="https://$VM_STATIC_IP.sslip.io"
			say '  diturunkan dari VM_STATIC_IP, tidak ditanyakan'
			;;
		smtp_pass)
			if [[ -z ${ENV_VALUES[SMTP_USER]-} ]]; then
				ENV_VALUES[$key]=''
				say '  dilewati: SMTP_USER kosong, jadi SMTP_PASS ikut kosong'
			else
				ask_value "$key"
			fi
			;;
		*) ask_value "$key" ;;
		esac
	done
	# docs/spec-deploy-uji-v1.md makes one without the other an error in the SMTP sender. Catch it
	# here rather than at the first email.
	if [[ -v ENV_VALUES[SMTP_USER] && -v ENV_VALUES[SMTP_PASS] ]]; then
		if [[ -n ${ENV_VALUES[SMTP_USER]} && -z ${ENV_VALUES[SMTP_PASS]} ]] ||
			[[ -z ${ENV_VALUES[SMTP_USER]} && -n ${ENV_VALUES[SMTP_PASS]} ]]; then
			die 'SMTP_USER dan SMTP_PASS harus sama-sama terisi atau sama-sama kosong.'
		fi
	fi
}

ask_ca_path() {
	local answer
	say ''
	say 'Sertifikat CA Supabase'
	say "  DATABASE_URL memakai sslrootcert, jadi VM butuh CA Supabase di $REMOTE_DIR/certs/supabase-ca.crt."
	say '  Isi jalurnya di WSL (dari dasbor Supabase: Database settings, SSL Configuration), misalnya'
	say '  /mnt/c/Users/<nama>/Downloads/prod-ca-2021.crt.'
	if has_state has-ca; then
		say '  Enter untuk mempertahankan CA yang sudah ada di VM.'
	else
		say '  Enter untuk melewati.'
	fi
	while true; do
		printf '  > '
		IFS= read -r answer || die 'masukan berakhir sebelum jalur CA terisi.'
		[[ -t 0 ]] || printf '\n'
		if [[ -z $answer ]]; then
			say '  dilewati'
			return 0
		fi
		if [[ $answer == \~/* ]]; then
			answer="$HOME/${answer#\~/}"
		fi
		if [[ -f $answer && -r $answer ]] && grep -q -e '-----BEGIN CERTIFICATE-----' -- "$answer"; then
			ca_path=$answer
			say '  diterima'
			return 0
		fi
		warn 'berkas itu tidak ada, tidak terbaca, atau bukan sertifikat PEM. Ulangi, atau Enter untuk melewati.'
	done
}

# Writes the server's .env to standard output. Only ever piped into ssh or into list_names.
render_env() {
	local key
	printf '%s\n' \
		'# Ditulis scripts/setup-env.sh dari .env.production.example; jalankan wizard itu lagi untuk' \
		'# mengubahnya. Setiap nilai berkutip tunggal, jadi docker compose membacanya apa adanya.'
	for key in "${KEYS[@]}"; do
		printf "%s='%s'\n" "$key" "${ENV_VALUES[$key]}"
	done
	printf '%s\n' "$END_MARKER"
}

# Reads rendered lines and prints only the name before each `=`.
list_names() {
	local line
	while IFS= read -r line; do
		if [[ $line =~ ^([A-Z_][A-Z0-9_]*)= ]]; then
			printf '  %s\n' "${BASH_REMATCH[1]}"
		fi
	done
}

summary() {
	say ''
	say "Siap menulis $REMOTE_DIR/.env di $target dengan variabel berikut (nama saja):"
	render_env | list_names
	if ((dry_run)); then
		say '  (dry-run: konfirmasi dilewati)'
		return 0
	fi
	confirm ya
}

transfer() {
	local mode
	say ''
	say "Menyalin ke $target:$REMOTE_DIR"
	run scp "${scp_opts[@]}" -- "$ROOT/docker-compose.prod.yml" "$ROOT/Caddyfile" "$target:$REMOTE_DIR/"
	if [[ -n $ca_path ]]; then
		run scp "${scp_opts[@]}" -- "$ca_path" "$target:$REMOTE_DIR/certs/supabase-ca.crt"
	fi
	printf '+ render_env | %s\n' "$(format_cmd "${ssh_cmd[@]}" "$REMOTE_WRITE_ENV")"
	if ((dry_run)); then
		say '  (dry-run: tidak ada yang dijalankan)'
		return 0
	fi
	mode=$(render_env | "${ssh_cmd[@]}" "$REMOTE_WRITE_ENV") ||
		die "menulis $REMOTE_DIR/.env gagal; .env yang lama, bila ada, tidak berubah."
	[[ $mode == 600 ]] || die "$REMOTE_DIR/.env tertulis dengan mode $mode, bukan 600. Periksa VM."
	say "  $REMOTE_DIR/.env ditulis, mode 600 sejak dibuat"
}

finish() {
	say ''
	if ((dry_run)); then
		say 'Dry-run selesai. Tidak ada yang dikirim ke VM.'
		return 0
	fi
	if [[ -z $ca_path ]] && ! has_state has-ca; then
		warn "$REMOTE_DIR/certs/supabase-ca.crt belum ada di VM. deploy.sh berhenti sebelum build selama DATABASE_URL memakai sslrootcert dan berkas itu belum ada: jalankan wizard ini lagi dengan jalurnya, atau salin sendiri dengan scp."
	fi
	say 'Selesai. Langkah berikutnya: bash scripts/deploy.sh'
}

# If the wizard stops during a hidden read, give the terminal its echo back.
restore_echo() {
	if [[ -t 0 ]]; then
		stty echo 2>/dev/null || true
	fi
}

main() {
	parse_args "$@"
	trap restore_echo EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	load_deploy_env "$DEPLOY_ENV_FILE"
	check_deploy_env
	read_example_keys
	command -v openssl >/dev/null || die 'openssl tidak ditemukan di WSL: sudo apt-get install openssl.'
	if ((dry_run)); then
		say 'DRY RUN: pertanyaannya sama, tetapi hanya nama variabel dan perintah yang dicetak, dan tidak ada yang dikirim ke VM.'
	elif ! command -v ssh >/dev/null || ! command -v scp >/dev/null; then
		die 'ssh atau scp tidak ditemukan di WSL: sudo apt-get install openssh-client.'
	fi
	check_ssh_key
	preflight_vm
	ask_all
	ask_ca_path
	summary
	transfer
	finish
}

main "$@"
