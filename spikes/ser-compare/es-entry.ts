// esbuild 打包入口：protobuf-es（protoc-gen-es v2）的生成码 + 运行时
export { StatePacketSchema, StatePacketSoASchema, EntityStateSchema } from './gen/es/state_pb.js';
export { create, toBinary, fromBinary, toJson, fromJson } from '@bufbuild/protobuf';
