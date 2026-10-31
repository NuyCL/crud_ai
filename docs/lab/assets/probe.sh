#!/usr/bin/env bash
# usage: probe.sh PORT
P=$1; A='X-Admin-Key: test-admin-key'
probe() { printf '%-34s -> ' "$1 $2"; curl -s --path-as-is -X "$1" -o /dev/null -w '%{http_code} %{content_type}\n' "localhost:$P$2" -H "$A"; }
for p in '%FF' '%C3%28' '%00' 'a%2Fb' 'a;b' '%zz'; do probe GET "/v1/flags/$p"; done
curl -s -XPOST localhost:$P/v1/flags -H "$A" -d '{"key":"a","enabled":true}' -o /dev/null
probe GET "/v1/flags/%61"
for m in PATCH OPTIONS; do probe $m /v1/flags/a; done
for p in /error /docs /openapi.json /v1/%65valuate; do probe GET $p; done
curl -s -XDELETE localhost:$P/v1/flags/a -H "$A" -o /dev/null
