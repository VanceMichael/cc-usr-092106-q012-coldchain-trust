# 伪冷链药品运输可信证明

描述药品冷链运输中箱体、传感器、交接和质量结论的关系，并提供一套**运输可信证明后台**：把箱体、药品批次、承运任务、交接人、传感器身份、校准版本、温度片段和开箱事件组成连续证据，供药品质量团队核验与追查。

## 领域资料

仓库中的 `contracts/context.schema.json` 描述基础资料格式，`fixtures/context.json` 给出可公开使用的示例。代码库只负责读取与校验这些资料，业务服务可沿用相同标识和版本约定。

当前资料反映的事实包括：

- 犯罪团伙可能用泡沫箱和铝箔纸伪装冷链
- 失控流通会带来药品变质风险
- 多轮收购使责任链更难还原

## 后台架构

追加式事件日志是唯一事实来源（`src/store/eventStore.js`），投影折叠出当前状态（`src/store/projection.js`），所有变更经命令服务校验后落日志（`src/service/commands.js`），查询服务只读（`src/service/queries.js`）。无第三方依赖。

```
src/
  domain/    时间区间、质量规则、证据时间线、批次血缘
  store/     事件存储（内存 / JSONL 持久化）与投影
  service/   命令（写）与查询（读）
  api/       HTTP 接口（node:http）
```

### 核心不变量

- **缺口显式**：一个读数最多覆盖到下一个读数或标称采样间隔结束；此外的时段一律标为 `gap`（原因：`no_sensor` / `sensor_offline` / `data_missing` / `calibration_invalid` / `untracked`），绝不用相邻读数自动填成合格。
- **放行不改写**：放行结论签发即冻结（含证据哈希与证据摘要）。晚到数据只会把结论标记为 `contested`，由签署人复核后追加 `confirmed` 或 `revoked`；原结论、撤销原因与签署人全部留痕。
- **责任段连续**：换箱、拼箱、拆分、设备掉线、跨时区运输都保留实际责任段。交接时校验责任方一致性；跨时区时间归一化为 UTC 计算，原始带时区字符串保留备查。
- **处置引用规则**：异常处置（`observe` 继续观察 / `quarantine` 隔离 / `scrap` 报废）必须引用已注册的质量规则版本并由签署人签名；规则按版本注册后不可变。
- **传感器身份**：温度片段只能由当时确实绑定在箱上的传感器上报，入库时解析并记录校准版本。

### 主要接口

命令（POST）：`/rules` `/sensors` `/sensors/calibrations` `/boxes` `/boxes/bind` `/boxes/unbind` `/boxes/opens` `/batches` `/batches/load` `/batches/unload` `/ops/rebox` `/ops/consolidate` `/ops/split` `/tasks` `/tasks/attach` `/handovers` `/readings` `/releases` `/releases/revoke` `/releases/confirm` `/dispositions` `/notifications/sent`

查询（GET）：

- `GET /scan/:boxId?from&to` — 接收方扫描一箱：可核验区间、超限与缺口、责任段、开箱事件、箱内批次的放行状态与处置
- `GET /batches/:id/evidence?from&to` — 批次跨箱连续证据链
- `GET /releases/:id/trace` — 质量负责人追查：结论状态流转、触发质疑的晚到片段、下游批次通知（含仍未通知的）
- `GET /notifications/pending` — 仍待通知的下游批次

## 运行

```bash
npm test          # 本地校验与全部不变量测试
npm start         # 启动后台（PORT 指定端口，COLDCHAIN_DB 指定 JSONL 持久化文件，缺省纯内存）
```

所有示例均为虚构数据，不含真实个人信息、账号或访问凭据。
