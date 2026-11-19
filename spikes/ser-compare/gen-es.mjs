// 用 protobuf-es（@bufbuild/protoc-gen-es）生成 TS 代码 —— 绕开 Windows 上的插件可执行问题。
//
// 背景：protoc 与 buf 都要求插件是**可执行文件**，而 npm 在 Windows 上只产出
// protoc-gen-es.cmd/.ps1，直接传给 --plugin= 会以 "'.' 不是内部或外部命令" 失败
// （本仓库实测：protoc 与 buf generate 都是一样的失败）。
//
// 解法：protoc 只用来产出 FileDescriptorSet，然后自己构造 CodeGeneratorRequest
// 喂给插件的 stdin —— 这正是 protoc 内部做的事，只是我们手动走一遍。
//
// 运行：node gen-es.mjs
// 前置：protoc 已把 descriptor 写到 gen/state.desc（见 build.sh 里的那一行）

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { CodeGeneratorRequestSchema, CodeGeneratorResponseSchema, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

const OUT_DIR_DEFAULT = 'gen/es';
const DESC = process.argv[2] ?? 'gen/state.desc';
const FILE = process.argv[3] ?? 'state.proto';
const OUT = process.argv[4] ?? OUT_DIR_DEFAULT;
// 相对**本文件**解析，而不是相对 CWD —— 否则从别的目录调用会找不到插件
const PLUGIN = fileURLToPath(new URL('./node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es', import.meta.url));

const fds = fromBinary(FileDescriptorSetSchema, readFileSync(DESC));
const request = create(CodeGeneratorRequestSchema, {
  fileToGenerate: [FILE],
  parameter: 'target=ts',
  protoFile: fds.file,
});

const response = fromBinary(
  CodeGeneratorResponseSchema,
  execFileSync(process.execPath, [PLUGIN], { input: toBinary(CodeGeneratorRequestSchema, request), maxBuffer: 64 << 20 }),
);

if (response.error) throw new Error(`protoc-gen-es: ${response.error}`);

for (const f of response.file) {
  const path = join(OUT, f.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, f.content);
  console.log(`written ${path} (${f.content.length} bytes)`);
}
