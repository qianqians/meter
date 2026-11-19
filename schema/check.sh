#!/usr/bin/env bash
# 框架协议的 codegen + 结构校验。生成物全部落在 schema/.gen/（已 gitignore）。
#
# 依赖（一次性，复用 spikes/ser-compare 装好的工具链）：
#   protoc          spikes/ser-compare/tools/protoc/bin/protoc.exe
#   protoc-gen-go   $(go env GOPATH)/bin/protoc-gen-go.exe
#   protoc-gen-es   spikes/ser-compare/node_modules/@bufbuild/protoc-gen-es
#   esbuild         spikes/ser-compare/node_modules/.bin/esbuild
#
# 用法：./check.sh
set -euo pipefail
cd "$(dirname "$0")"

PROTOC=../spikes/ser-compare/tools/protoc/bin/protoc.exe
SC=../spikes/ser-compare
GEN=.gen
LIST="pb/common.proto pb/envelope.proto pb/client_gate.proto pb/gate_logic.proto pb/logic_dbproxy.proto pb/logic_logic.proto"
NAMES=(common.proto envelope.proto client_gate.proto gate_logic.proto logic_dbproxy.proto logic_logic.proto)

rm -rf "$GEN"
mkdir -p "$GEN/go" "$GEN/es" "$GEN/js"

echo "① protoc 编译 + descriptor set"
"$PROTOC" -I pb --descriptor_set_out="$GEN/fw.desc" --include_imports $LIST

echo "② protoc-gen-go"
"$PROTOC" --plugin=protoc-gen-go="$(go env GOPATH)/bin/protoc-gen-go.exe" \
  --go_out="$GEN/go" --go_opt=paths=source_relative -I pb $LIST

echo "③ protoc-gen-es（经 gen-es.mjs 绕开 Windows 上 npm 只给 .cmd 的问题）"
for f in "${NAMES[@]}"; do
  node "$SC/gen-es.mjs" "$GEN/fw.desc" "$f" "$GEN/es" > /dev/null
done

echo "④ methods.yaml → 常量（TS + Go）"
node gen-methods.mjs "$GEN/methods.ts" "$GEN/go/methods_gen.go"

echo "⑤ 打包（entry 放在 spikes/ser-compare 下，好让 @bufbuild/protobuf 解析到它的 node_modules）"
cat > "$SC/gen/fw-entry.ts" <<'EOF'
export * from '../../../schema/.gen/es/envelope_pb.js';
export * from '../../../schema/.gen/es/common_pb.js';
export * from '../../../schema/.gen/es/client_gate_pb.js';
export * from '../../../schema/.gen/es/gate_logic_pb.js';
export * from '../../../schema/.gen/es/logic_dbproxy_pb.js';
export * from '../../../schema/.gen/es/logic_logic_pb.js';
export * from '../../../schema/.gen/methods.js';
export { create, toBinary, fromBinary } from '@bufbuild/protobuf';
EOF
NODE_PATH="$(cd "$SC/node_modules" && pwd)" "$SC/node_modules/.bin/esbuild" "$SC/gen/fw-entry.ts" \
  --bundle --format=esm --platform=node --outfile="$GEN/js/fw.mjs" \
  --resolve-extensions=.ts,.js --log-level=error

echo "⑥ 结构校验"
node verify.mjs

echo
echo "OK: Go $(ls "$GEN/go" | wc -l) 个文件 / TS $(ls "$GEN/es" | wc -l) 个文件 / bundle $(ls -la "$GEN/js/fw.mjs" | awk '{print $5}') 字节"
