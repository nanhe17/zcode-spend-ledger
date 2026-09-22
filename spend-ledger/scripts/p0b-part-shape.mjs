// P0b 探针：确认 part.data 中文件路径与体积的真实位置。
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.ZCODE_HOME || join(homedir(), ".zcode");
const db = new DatabaseSync(join(home, "cli", "db", "db.sqlite"), { readOnly: true });

const P = (label, v) => console.log("\n== " + label + " ==\n" + JSON.stringify(v, null, 1).slice(0, 1400));

P("part.type 分布", db.prepare(`select json_extract(data,'$.type') t, count(*) c from part group by 1 order by c desc`).all());
P("part.tool 分布", db.prepare(`select json_extract(data,'$.tool') t, count(*) c, sum(length(data)) bytes
  from part where json_extract(data,'$.type')='tool' group by 1 order by c desc limit 15`).all());

// 各类工具的状态键结构
for (const tool of ["Read", "Edit", "Write", "Bash", "WebFetch"]) {
  const rows = db.prepare(`select data from part where json_extract(data,'$.tool')=? limit 2`).all(tool);
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.data); } catch { continue; }
    const st = d.state || {};
    P(`${tool} state 键`, {
      dataKeys: Object.keys(d),
      stateKeys: Object.keys(st),
      status: st.status,
      inputKeys: st.input ? Object.keys(st.input) : null,
      inputFilePath: st.input?.file_path ?? null,
      metadataKeys: st.metadata ? Object.keys(st.metadata) : null,
      readFileStatePath: st.metadata?.readFileState?.path ?? null,
      displayKeys: st.metadata?.display ? Object.keys(st.metadata.display) : null,
      displayFilePath: st.metadata?.display?.filePath ?? null,
      serialization: st.metadata?.serialization ?? null,
      outputLen: typeof st.output === "string" ? st.output.length : null,
    });
    break;
  }
}

// 统计三种路径来源的覆盖率
P("路径可提取覆盖率", db.prepare(`select
    sum(case when json_extract(data,'$.state.input.file_path') is not null then 1 else 0 end) input_fp,
    sum(case when json_extract(data,'$.state.metadata.readFileState.path') is not null then 1 else 0 end) read_fp,
    sum(case when json_extract(data,'$.state.metadata.display.filePath') is not null then 1 else 0 end) display_fp,
    sum(case when json_extract(data,'$.type')='tool' then 1 else 0 end) tool_parts
  from part`).get());

P("Read 高频文件", db.prepare(`select json_extract(data,'$.state.input.file_path') fp, count(*) c,
    sum(length(json_extract(data,'$.state.output'))) out_bytes
  from part where json_extract(data,'$.tool')='Read' and fp is not null group by 1 order by c desc limit 8`).all());

P("索引库 tasks 样例", (() => {
  try {
    const idx = new DatabaseSync(join(home, "v2", "tasks-index.sqlite"), { readOnly: true });
    return idx.prepare("select workspace_path, task_id, title, model, provider, mode, task_status from tasks order by updated_at desc limit 4").all();
  } catch (e) { return "ERR " + e.message; }
})());

P("会话表样例", db.prepare(`select id, directory, title, task_type, title_source, time_created from session order by time_created desc limit 4`).all());
db.close();
