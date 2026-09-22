// 命令入口。任何异常都降级为可读输出 + 非零退出码，绝不打印堆栈吓到用户；
// 加 --debug 才输出完整堆栈。
import { main } from "./cli.mjs";

try {
  const out = await main();
  if (out != null && out !== "") process.stdout.write(out + "\n");
} catch (err) {
  if (process.argv.includes("--debug")) {
    console.error(err?.stack ?? String(err));
  } else {
    console.error("spend-ledger 执行失败：" + (err?.message ?? String(err)));
    console.error("加 --debug 查看完整堆栈。");
  }
  process.exitCode = 1;
}
