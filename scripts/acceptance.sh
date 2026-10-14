#!/usr/bin/env bash
# Acceptance checks for the gh-proxy hardening spec.
#
# Usage: scripts/acceptance.sh [base-url] [output-dir]
# Prints every command and its raw output; nothing is summarized away.
set -uo pipefail

BASE="${1:-https://gh-proxy.7s.pub}"
OUT="${2:-acceptance-out-$(date +%Y%m%d-%H%M%S)}"
TAG="v1.14.2"
ASSET="sing-box-1.14.2-linux-arm64-glibc.tar.gz"
ASSET_URL="https://github.com/SagerNet/sing-box/releases/download/$TAG/$ASSET"
U="$BASE/$ASSET_URL"
GEOIP_URL="https://github.com/SagerNet/sing-geoip/releases/latest/download/geoip.db"
G="$BASE/$GEOIP_URL"

mkdir -p "$OUT"
cd "$OUT" || exit 1

step() { printf '\n\n########## %s ##########\n' "$1"; }
# shellcheck disable=SC2317
run() { printf '$ %s\n' "$*"; "$@"; }

echo "base=$BASE"
echo "out=$PWD"
echo "curl=$(curl --version | head -1)"

step "0. healthz"
run curl -sS -m 20 -D healthz.h -w '\nhttp=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s\n' "$BASE/healthz"
cat healthz.h

step "1. byte identity: proxied cold, proxied warm (cache), direct upstream"
run curl -fsSL -m 900 -D cold.h -o cold.tar.gz -w 'cold http=%{http_code} bytes=%{size_download} speed=%{speed_download} ttfb=%{time_starttransfer} total=%{time_total}\n' "$U"
grep -iE '^(HTTP|cf-ray|x-proxy-cache|cf-cache-status|content-length|etag|last-modified|age|cache-control)' cold.h
run sha256sum cold.tar.gz

run curl -fsSL -m 900 -D warm.h -o warm.tar.gz -w 'warm http=%{http_code} bytes=%{size_download} speed=%{speed_download} ttfb=%{time_starttransfer} total=%{time_total}\n' "$U"
grep -iE '^(HTTP|cf-ray|x-proxy-cache|cf-cache-status|content-length|age|cache-control)' warm.h
run sha256sum warm.tar.gz

printf '$ curl --noproxy "*" (direct upstream, 30s cap)\n'
if curl -fsSL -m 30 --noproxy '*' -D direct.h -o direct.tar.gz -w 'direct http=%{http_code} bytes=%{size_download}\n' "$ASSET_URL"; then
  run sha256sum direct.tar.gz
  printf '$ cmp cold.tar.gz direct.tar.gz\n'
  cmp cold.tar.gz direct.tar.gz && echo 'cmp: identical'
  printf '$ cmp warm.tar.gz direct.tar.gz\n'
  cmp warm.tar.gz direct.tar.gz && echo 'cmp: identical'
else
  echo 'direct download unavailable from this network (no-proxy path blocked); byte comparison limited to proxied cold/warm copies'
fi
run sha256sum cold.tar.gz warm.tar.gz

step "2. HEAD and Range"
run curl -sS -m 60 -I -o /dev/null -D head.h -w 'head http=%{http_code}\n' "$U"
cat head.h

run curl -sS -m 120 -L -o /dev/null -D range.h -r 0-1048575 -w 'range http=%{http_code} bytes=%{size_download} speed=%{speed_download} ttfb=%{time_starttransfer}\n' "$U"
grep -iE '^(HTTP|content-range|content-length|accept-ranges|x-proxy-cache)' range.h

head -c 1048576 cold.tar.gz > partial.bin
cp partial.bin resume.bin
run curl -sS -m 900 -C - -o resume.bin -D resume.h -w 'resume http=%{http_code} bytes=%{size_download} speed=%{speed_download}\n' "$U"
grep -iE '^(HTTP|content-range|x-proxy-cache)' resume.h
run ls -l partial.bin resume.bin cold.tar.gz
printf '$ cmp resume.bin cold.tar.gz\n'
cmp resume.bin cold.tar.gz && echo 'resume bytes: identical'

step "3. conditional request (304)"
ET=$(curl -sS -m 60 -I "$U" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
LM=$(curl -sS -m 60 -I "$U" | tr -d '\r' | awk -F': ' 'tolower($1)=="last-modified"{print $2}')
echo "etag=$ET"
echo "last-modified=$LM"
run curl -sS -m 60 -o /dev/null -D inm.h -w 'if-none-match http=%{http_code}\n' -H "If-None-Match: $ET" "$U"
grep -iE '^(HTTP|etag|last-modified|x-proxy-cache|cache-control)' inm.h
run curl -sS -m 60 -o /dev/null -D ims.h -w 'if-modified-since http=%{http_code}\n' -H "If-Modified-Since: $LM" "$U"
grep -iE '^(HTTP|etag|last-modified|x-proxy-cache)' ims.h

step "4. releases/latest redirect"
run curl -sS -m 60 -o /dev/null -L -w 'latest url_effective=%{url_effective}\nhttp=%{http_code}\n' "$BASE/https://github.com/SagerNet/sing-box/releases/latest"

step "5. rolling asset (geoip.db) + conditional"
GEOIP_TAG_URL=$(curl -sS -m 60 -o /dev/null -w '%{redirect_url}' -I "$G")
echo "geoip latest redirect_url=$GEOIP_TAG_URL"
if [ -n "$GEOIP_TAG_URL" ]; then G2="$GEOIP_TAG_URL"; else G2="$G"; echo 'redirect not resolved, falling back to the latest/download url with -L'; fi
run curl -sS -m 120 -I "$G2"
run curl -sS -m 300 -L -o geoip.db -D geoip-get.h -w 'geoip http=%{http_code} bytes=%{size_download} speed=%{speed_download} ttfb=%{time_starttransfer}\n' "$G2"
grep -iE '^(HTTP|x-proxy-cache|cf-cache-status|content-length|etag|last-modified|cache-control)' geoip-get.h
GLM=$(curl -sS -m 60 -I "$G2" | tr -d '\r' | awk -F': ' 'tolower($1)=="last-modified"{print $2}')
GETAG=$(curl -sS -m 60 -I "$G2" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
echo "geoip last-modified=$GLM etag=$GETAG"
run curl -sS -m 60 -o /dev/null -D geoip-ims.h -w 'geoip if-modified-since http=%{http_code}\n' -H "If-Modified-Since: $GLM" "$G2"
grep -iE '^(HTTP|x-proxy-cache|etag|last-modified)' geoip-ims.h

step "6. concurrency ceiling (50 parallel healthz, no rate limit)"
for i in $(seq 1 50); do
  curl -sS -m 60 -o /dev/null -w "%{http_code}\n" "$BASE/healthz" &
done > codes-healthz.txt
wait
sort codes-healthz.txt | uniq -c

step "7. whitelist and scheme rejection"
run curl -sS -m 30 -o /dev/null -w 'example.com http=%{http_code}\n' "$BASE/https://example.com/"
run curl -sS -m 30 -o /dev/null -w 'http://github.com http=%{http_code}\n' "$BASE/http://github.com/"
run curl -sS -m 30 -o /dev/null -w 'github.com.evil.example http=%{http_code}\n' "$BASE/https://github.com.evil.example/x"

step "8. cache behaviour sample (same asset, 3 HEADs)"
for i in 1 2 3; do
  curl -sS -m 60 -I -o /dev/null -D "head$i.h" -w "head$i http=%{http_code} ttfb=%{time_starttransfer}\n" "$U"
  grep -iE '^(x-proxy-cache|cf-cache-status|age):' "head$i.h" || true
done

step "9. concurrency (4 parallel ranges)"
for i in 0 1 2 3; do
  start=$((i * 4194304))
  end=$((start + 1048576))
  curl -sS -m 300 -o /dev/null -r "$start-$end" -w "par$i http=%{http_code} bytes=%{size_download} speed=%{speed_download}\n" "$U" &
done
wait

echo
echo "done: $PWD"
