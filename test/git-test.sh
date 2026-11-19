#!/bin/bash
# Git smart HTTP tests against a running forge.
# Usage: FORGE_PORT=45225 bash test/git-test.sh
set -u
PORT="${FORGE_PORT:?set FORGE_PORT}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="testtoken123"
WORK="/tmp/forge-git-test"
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK" || exit 1

PASS=0
FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1"; }

# create repo via REST
curl -s -X POST "$BASE/api/v3/user/repos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"gitrepo"}' > /dev/null

# clone empty repo
if git clone "$BASE/adaiversen/gitrepo.git" empty-clone 2>clone-empty.log; then ok "clone empty repo"; else bad "clone empty repo: $(tail -2 clone-empty.log)"; fi

# build a local repo with 3 commits and push
git init -q src && cd src || exit 1
git config user.name "Tester"
git config user.email "tester@example.invalid"
git config commit.gpgsign false
echo "one" > a.txt && git add . && git commit -qm "commit one"
echo "two" > b.txt && git add . && git commit -qm "commit two"
mkdir -p sub && echo "three" > sub/c.txt && git add . && git commit -qm "commit three"
git branch -M main
if git push "$BASE/adaiversen/gitrepo.git" main 2>push1.log; then ok "push 3 commits"; else bad "push 3 commits: $(cat push1.log)"; fi
cd "$WORK" || exit 1

# clone back and verify files
if git clone "$BASE/adaiversen/gitrepo.git" clone1 2>clone1.log; then ok "clone pushed repo"; else bad "clone pushed repo: $(cat clone1.log)"; fi
if [ -f clone1/a.txt ] && [ -f clone1/b.txt ] && [ -f clone1/sub/c.txt ]; then ok "clone has all files"; else bad "clone missing files"; fi
if [ "$(git -C clone1 log --oneline | wc -l)" = "3" ]; then ok "clone has 3 commits"; else bad "clone commit count: $(git -C clone1 log --oneline | wc -l)"; fi

# fetch in the clone (incremental, nothing new)
if git -C clone1 fetch origin 2>fetch1.log; then ok "fetch nothing new"; else bad "fetch nothing new: $(cat fetch1.log)"; fi

# push a 4th commit, then fetch it
cd src || exit 1
echo "four" > d.txt && git add . && git commit -qm "commit four"
if git push "$BASE/adaiversen/gitrepo.git" main 2>push2.log; then ok "push 4th commit"; else bad "push 4th commit: $(cat push2.log)"; fi
cd "$WORK" || exit 1
if git -C clone1 pull --ff-only 2>pull1.log; then ok "pull 4th commit"; else bad "pull 4th commit: $(cat pull1.log)"; fi
if [ -f clone1/d.txt ]; then ok "pulled file present"; else bad "pulled file missing"; fi

# shallow clone depth 1
if git clone --depth 1 "$BASE/adaiversen/gitrepo.git" shallow1 2>shallow1.log; then ok "shallow clone depth 1"; else bad "shallow clone: $(cat shallow1.log)"; fi
if [ "$(git -C shallow1 log --oneline | wc -l)" = "1" ]; then ok "shallow clone has 1 commit"; else bad "shallow commit count"; fi

# deepen from shallow
if git -C shallow1 fetch --deepen 1 origin 2>deepen.log; then ok "deepen 1"; else bad "deepen: $(cat deepen.log)"; fi
if [ "$(git -C shallow1 log --oneline | wc -l)" = "2" ]; then ok "deepened to 2 commits"; else bad "deepen count: $(git -C shallow1 log --oneline | wc -l)"; fi

# tag push + peel
cd src || exit 1
git tag -a v1.0 -m "version 1.0"
if git push "$BASE/adaiversen/gitrepo.git" v1.0 2>pushtag.log; then ok "push annotated tag"; else bad "push tag: $(cat pushtag.log)"; fi
cd "$WORK" || exit 1
if git clone "$BASE/adaiversen/gitrepo.git" clone2 2>clone2.log && git -C clone2 tag -l | grep -q v1.0; then ok "tag cloned"; else bad "tag clone: $(cat clone2.log)"; fi

# non-fast-forward push must be refused
cd src || exit 1
git reset --hard -q HEAD~1
echo "rewritten" > a.txt && git add . && git commit -qm "rewritten history"
if git push "$BASE/adaiversen/gitrepo.git" main 2>nff.log; then bad "non-fast-forward push was accepted"; else
  if grep -qi "non-fast-forward" nff.log; then ok "non-fast-forward refused"; else bad "non-fast-forward refused without reason: $(cat nff.log)"; fi
fi
cd "$WORK" || exit 1

# branch push + delete
cd src || exit 1
git checkout -q -b side main
echo side > side.txt && git add . && git commit -qm "side work"
if git push "$BASE/adaiversen/gitrepo.git" side 2>pushside.log; then ok "push new branch"; else bad "push branch: $(cat pushside.log)"; fi
if git push "$BASE/adaiversen/gitrepo.git" :side 2>delside.log; then ok "delete branch"; else bad "delete branch: $(cat delside.log)"; fi
cd "$WORK" || exit 1

# missing repo 404 on info/refs
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/adaiversen/nothere.git/info/refs?service=git-upload-pack")
if [ "$CODE" = "404" ]; then ok "missing repo info/refs 404"; else bad "missing repo info/refs got $CODE"; fi

# push to a repo that does not exist must fail (no repo invention)
cd src || exit 1
if git push "$BASE/adaiversen/ghost.git" main 2>pushghost.log; then bad "push invented a repo"; else ok "push to missing repo refused"; fi
cd "$WORK" || exit 1

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
