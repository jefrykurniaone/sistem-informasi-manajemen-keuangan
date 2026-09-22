#!/usr/bin/env bash
# One-time preparation of the Ubuntu 24.04 VM, run on the VM itself as the SSH user (who needs
# sudo, as `ubuntu` on Lightsail has without a password). From WSL on the developer machine:
#
#   ssh -i ~/.ssh/komplek-uji.pem ubuntu@203.0.113.10 'bash -s' < scripts/bootstrap-vm.sh
#
# or copy the file over and run `bash bootstrap-vm.sh` in an SSH session. It installs Docker Engine
# and the compose plugin from Docker's own apt repository, adds the user to the `docker` group,
# creates a persistent 2 GB /swapfile, creates /opt/komplek with storage/ and certs/, and prints
# what is left to do. Every step looks before it acts, so a second run changes nothing and says so.
#
# Nothing here handles a secret. The application's .env is written later by scripts/setup-env.sh.

if [ -z "${BASH_VERSION:-}" ]; then
	echo 'Jalankan dengan bash, bukan sh: bash bootstrap-vm.sh' >&2
	exit 1
fi
set -euo pipefail

readonly APP_DIR=/opt/komplek
readonly SWAP_FILE=/swapfile
readonly SWAP_SIZE_MB=2048
readonly KEYRING=/etc/apt/keyrings/docker.asc
readonly SOURCES=/etc/apt/sources.list.d/docker.sources
readonly LEGACY_SOURCES=/etc/apt/sources.list.d/docker.list
readonly -a DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)
# From "Uninstall old versions" in Docker's install guide for Ubuntu: these clash with the packages above.
readonly -a CONFLICTING_PACKAGES=(docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc)

changes=0
target_user=''
target_group=''
group_added=0

say() { printf '%s\n' "$*"; }
warn() { printf 'PERINGATAN: %s\n' "$*" >&2; }
die() {
	printf 'GAGAL: %s\n' "$*" >&2
	exit 1
}
changed() {
	changes=$((changes + 1))
	say "  diubah: $*"
}
kept() { say "  sudah ada: $*"; }

# Runs a command as root: directly when this shell already is root, through sudo otherwise.
as_root() {
	if ((EUID == 0)); then
		"$@"
	else
		sudo "$@"
	fi
}

# apt-get without prompts. Standard input is closed so that, when this script arrives through
# `ssh ... 'bash -s'`, a package script can never read the rest of this file as its input. The lock
# timeout waits for unattended-upgrades, which holds the dpkg lock for a while after first boot.
apt_get() {
	as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
		apt-get -o DPkg::Lock::Timeout=600 "$@" </dev/null
}

is_installed() {
	local status
	status=$(dpkg-query -W -f="\${db:Status-Abbrev}" "$1" 2>/dev/null) || return 1
	[[ $status == ii* ]]
}

# Prints one value of /etc/os-release without sourcing it into this shell.
os_release_value() {
	local line value
	while IFS= read -r line; do
		if [[ $line == "$1="* ]]; then
			value=${line#*=}
			value=${value#\"}
			value=${value%\"}
			printf '%s\n' "$value"
			return 0
		fi
	done </etc/os-release
	return 1
}

preflight() {
	local version
	[[ $(os_release_value ID) == ubuntu ]] || die 'skrip ini untuk Ubuntu.'
	version=$(os_release_value VERSION_ID) || version=''
	if [[ $version != 24.04 ]]; then
		warn "VM ini Ubuntu $version, bukan 24.04 yang dipakai spesifikasi. Lanjut, tetapi periksa hasilnya."
	fi
	# The image is built with --platform linux/amd64 only (scripts/deploy.sh).
	[[ $(dpkg --print-architecture) == amd64 ]] || die 'image aplikasi hanya dibangun untuk linux/amd64; VM ini bukan amd64.'

	if ((EUID == 0)); then
		target_user=${SUDO_USER:-}
		if [[ -z $target_user || $target_user == root ]]; then
			die 'jalankan sebagai pengguna SSH biasa (misalnya ubuntu), bukan sebagai root: pengguna itulah yang masuk ke grup docker dan memiliki /opt/komplek.'
		fi
	else
		target_user=$(id -un)
		command -v sudo >/dev/null || die 'sudo tidak tersedia.'
		if ! sudo -n true 2>/dev/null; then
			say 'sudo meminta kata sandi.'
			sudo -v || die 'sudo gagal. Tanpa terminal (ssh ... bash -s), sudo harus tanpa kata sandi; atau salin skrip ini ke VM dan jalankan di sesi SSH biasa.'
		fi
	fi
	target_group=$(id -gn "$target_user")
	say "Menyiapkan VM untuk pengguna $target_user."
}

docker_sources_content() {
	local codename
	codename=$(os_release_value UBUNTU_CODENAME || os_release_value VERSION_CODENAME) ||
		die 'kode rilis Ubuntu tidak terbaca dari /etc/os-release.'
	printf '%s\n' \
		'Types: deb' \
		'URIs: https://download.docker.com/linux/ubuntu' \
		"Suites: $codename" \
		'Components: stable' \
		"Architectures: $(dpkg --print-architecture)" \
		"Signed-By: $KEYRING"
}

ensure_docker_repository() {
	local missing=() pkg expected
	if [[ -e $LEGACY_SOURCES ]]; then
		die "$LEGACY_SOURCES dari cara pasang lama masih ada dan akan bentrok dengan $SOURCES. Hapus berkas itu lalu jalankan ulang."
	fi

	if [[ -s $KEYRING ]]; then
		kept "kunci GPG Docker di $KEYRING"
	else
		for pkg in ca-certificates curl; do
			is_installed "$pkg" || missing+=("$pkg")
		done
		if ((${#missing[@]} > 0)); then
			apt_get update
			apt_get install -y "${missing[@]}"
			changed "memasang ${missing[*]}"
		fi
		as_root install -m 0755 -d /etc/apt/keyrings
		as_root curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$KEYRING"
		as_root chmod a+r "$KEYRING"
		changed "kunci GPG Docker di $KEYRING"
	fi

	expected=$(docker_sources_content)
	if [[ -f $SOURCES && $(<"$SOURCES") == "$expected" ]]; then
		kept "repositori apt Docker di $SOURCES"
	else
		printf '%s\n' "$expected" | as_root tee "$SOURCES" >/dev/null
		changed "repositori apt Docker di $SOURCES"
	fi
}

ensure_docker() {
	local missing=() conflicts=() pkg
	say ''
	say '[1/4] Docker Engine dan plugin compose'
	ensure_docker_repository

	for pkg in "${DOCKER_PACKAGES[@]}"; do
		is_installed "$pkg" || missing+=("$pkg")
	done
	if ((${#missing[@]} == 0)); then
		kept "paket ${DOCKER_PACKAGES[*]}"
	else
		for pkg in "${CONFLICTING_PACKAGES[@]}"; do
			if is_installed "$pkg"; then
				conflicts+=("$pkg")
			fi
		done
		if ((${#conflicts[@]} > 0)); then
			die "paket ${conflicts[*]} bentrok dengan Docker Engine resmi. Hapus dulu dengan: sudo apt-get remove ${conflicts[*]}"
		fi
		apt_get update
		apt_get install -y "${missing[@]}"
		changed "memasang ${missing[*]}"
	fi

	if systemctl is-enabled --quiet docker && systemctl is-active --quiet docker; then
		kept 'layanan docker aktif dan menyala saat boot'
	else
		as_root systemctl enable --now docker
		changed 'layanan docker dinyalakan dan diaktifkan saat boot'
	fi
}

ensure_docker_group() {
	local groups
	say ''
	say '[2/4] Grup docker'
	groups=" $(id -nG "$target_user") "
	if [[ $groups == *' docker '* ]]; then
		kept "$target_user anggota grup docker"
	else
		as_root usermod -aG docker "$target_user"
		group_added=1
		changed "$target_user ditambahkan ke grup docker"
	fi
}

swap_active() {
	local name _rest
	while read -r name _rest; do
		if [[ $name == "$SWAP_FILE" ]]; then
			return 0
		fi
	done </proc/swaps
	return 1
}

ensure_swap() {
	say ''
	say "[3/4] Swap ${SWAP_SIZE_MB} MB di $SWAP_FILE"
	if swap_active; then
		kept "$SWAP_FILE aktif"
	elif [[ -e $SWAP_FILE ]]; then
		as_root swapon "$SWAP_FILE" ||
			die "$SWAP_FILE sudah ada tetapi tidak bisa dipakai sebagai swap. Periksa berkas itu, hapus bila bukan swap, lalu jalankan ulang."
		changed "$SWAP_FILE dinyalakan"
	else
		# Swap holds pages of memory, so the file is 600 from the moment it exists: it is created under
		# umask 077, which sudo keeps because it applies the stricter of the caller's umask and its own.
		(umask 077 && as_root fallocate -l "${SWAP_SIZE_MB}M" "$SWAP_FILE") ||
			(umask 077 && as_root dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" status=none)
		as_root chmod 600 "$SWAP_FILE"
		as_root mkswap "$SWAP_FILE" >/dev/null
		as_root swapon "$SWAP_FILE"
		changed "$SWAP_FILE dibuat dan dinyalakan"
	fi

	if grep -Eq "^[[:space:]]*${SWAP_FILE}[[:space:]]" /etc/fstab; then
		kept "$SWAP_FILE di /etc/fstab"
	else
		printf '%s none swap sw 0 0\n' "$SWAP_FILE" | as_root tee -a /etc/fstab >/dev/null
		changed "$SWAP_FILE ditambahkan ke /etc/fstab supaya menyala setelah boot ulang"
	fi
}

ensure_dir() {
	local dir=$1 owner
	if [[ -d $dir ]]; then
		owner=$(stat -c %U "$dir")
		if [[ $owner == "$target_user" ]]; then
			kept "$dir"
		else
			as_root chown "$target_user:$target_group" "$dir"
			changed "pemilik $dir menjadi $target_user"
		fi
	else
		as_root install -d -m 750 -o "$target_user" -g "$target_group" "$dir"
		changed "$dir dibuat"
	fi
}

ensure_app_dir() {
	say ''
	say "[4/4] Direktori aplikasi $APP_DIR"
	ensure_dir "$APP_DIR"
	# Uploaded files, mounted at /app/storage by docker-compose.prod.yml.
	ensure_dir "$APP_DIR/storage"
	# The Supabase CA certificate that DATABASE_URL names with sslrootcert, mounted at /app/certs.
	ensure_dir "$APP_DIR/certs"
}

print_next_steps() {
	local ca_state='belum ada'
	if [[ -s $APP_DIR/certs/supabase-ca.crt ]]; then
		ca_state='sudah ada'
	fi

	say ''
	say "Selesai. Perubahan pada jalan ini: $changes."
	say ''
	say 'Langkah berikutnya:'
	if ((group_added)); then
		say "  - Keluar lalu masuk lagi SSH supaya $target_user bisa memakai docker tanpa sudo."
	fi
	say '  - Di Lightsail, tab Networking instance ini: pasang IP statis bila belum, dan buka TCP 443'
	say '    serta UDP 443 di firewall selain TCP 22 dan 80. Caddy mengambil sertifikat lewat port 80'
	say '    dan melayani HTTPS di 443.'
	say "  - Sertifikat CA Supabase ($ca_state di $APP_DIR/certs/supabase-ca.crt): unduh dari dasbor"
	say '    Supabase (Database settings, SSL Configuration). setup-env.sh menyalinnya ke sana bila'
	say '    jalurnya diberikan; tanpa berkas itu migrate gagal karena DATABASE_URL memakai sslrootcert.'
	say '  - Di mesin pengembang, dari WSL di akar repositori: salin .env.deploy.example ke .env.deploy'
	say '    lalu isi, dan simpan kunci .pem di ~/.ssh dengan chmod 600.'
	say '  - Jalankan bash scripts/setup-env.sh: menulis /opt/komplek/.env dan menyalin'
	say '    docker-compose.prod.yml serta Caddyfile ke VM ini.'
	say '  - Jalankan bash scripts/deploy.sh. Setelah push pertama, jadikan paket GHCR'
	say '    sistem-informasi-manajemen-keuangan publik (Package settings, Change visibility) supaya'
	say '    VM ini bisa menariknya tanpa login.'
}

main() {
	preflight
	ensure_docker
	ensure_docker_group
	ensure_swap
	ensure_app_dir
	print_next_steps
}

# Called on the last line so that bash has read the whole file before anything runs, which matters
# when the file arrives on standard input through `ssh ... 'bash -s'`.
main "$@"
