#!/bin/bash
cd "$(dirname "$0")"
BAD="deadbeef000000000000000000000000"
GOOD="df3ed2cdfd024f5599dfa978a4f1368e"

show() {
  python3 -c "
import sys,json
t=sys.stdin.read(); i=t.rfind('\n{\n')
d=json.loads(t[i:]) if i>=0 else {}
print('ok=',d.get('ok'),'err=',(d.get('refused') or [{}])[0].get('err','')[:80])
"
}

printf "%-24s " "rest-uuid-mismatch"
env GQL_MODE=throw EXPECTED_STAGE="$BAD" node run.js "rest-uuid-mismatch" 1 2>/dev/null | show

printf "%-24s " "rest-uuid-match"
env GQL_MODE=throw EXPECTED_STAGE="$GOOD" node run.js "rest-uuid-match" 1 2>/dev/null | show
