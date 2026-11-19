// 期望结果：编译失败，且只有一条错误
//   error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
//
// 这条断言的意义：`core` 包一旦打开 erasableSyntaxOnly，`enum` / `namespace` /
// 参数属性 / 装饰器 这些"擦除模式跑不了"的语法在**写下的那一刻**就被拦住，
// 而不是等到 `node app.ts` 或 `tsx` 在运行时炸掉。
//
// 验证：npx --yes -p typescript@5.9 tsc -p .
enum Color { Red, Green }

export const c = Color.Red;
