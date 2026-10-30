#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/robodocks-tlc.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
# Official stable release. Never execute a rolling/latest download or an
# unverified local override. Java and the standard tools are prerequisites.
jar="$tmp/tla2tools.jar"
url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
sha256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
sha1=bee4a54f3ee3d4afc347c3240ec2d9e93b075104
java -version
curl --disable --fail --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 60 --output "$jar" "$url"
printf '%s  %s\n' "$sha256" "$jar" | sha256sum --check --status
printf '%s  %s\n' "$sha1" "$jar" | sha1sum --check --status
cp -- "$root/formal/Admission.tla" "$root/formal/Admission.cfg" "$tmp/"
cd -- "$tmp"
run() {
  timeout 60s java -XX:+UseParallelGC -Xmx512m -cp "$jar" tlc2.TLC \
    -workers 1 -seed 1 -fp 0 -metadir "$tmp/states-$1" \
    -config "$1.cfg" Admission > "$1.log" 2>&1
}
status=0
run Admission || status=$?
cat Admission.log
if [[ "$status" != 0 ]]; then
  printf 'Admission baseline failed with exit %s\n' "$status" >&2
  exit 1
fi
grep -Fq 'Model checking completed. No error has been found.' Admission.log
# Each deliberate guard mutation must expose its corresponding invariant,
# rather than merely fail due to syntax, missing tools, memory or timeout.
for pair in 'SkipSourceGate NoInvalidAdmission' \
            'OverwriteConflict NoConflictOverwrite' \
            'DuplicateReplay NoDuplicateAdmission'; do
  read -r mutation invariant <<< "$pair"
  sed "s/$mutation = FALSE/$mutation = TRUE/" Admission.cfg > "$mutation.cfg"
  status=0
  run "$mutation" || status=$?
  cat "$mutation.log"
  if [[ "$status" != 12 ]] || ! grep -Fq "Invariant $invariant is violated." "$mutation.log"; then
    printf 'Expected a checked %s counterexample; got exit %s\n' "$invariant" "$status" >&2
    exit 1
  fi
done
printf 'Admission model and all three deliberate invariant violations checked.\n'
