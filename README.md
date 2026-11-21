# distributed-config-change-window-planner
规划配置传播、功能开关和依赖服务的生效窗口

配置中心同时调整超时、重试和降级开关时，不同服务/实例的应用时间不一致，
可能出现"重试数已上升、降级尚未生效"的危险中间状态。本规划器根据
**依赖关系、版本兼容、实例应用时间、功能开关和错误预算**把变更切分成
有序推送批次，并为每个批次生成可独立执行的回滚计划。

要求 Node.js >= 24.16.0，无第三方依赖。

## 使用

```bash
node bin/plan.js examples/scenario.json   # 输出推送批次计划
npm test                                  # node --test
```

## 输入（scenario）

- `current`：各服务当前配置，用于生成回滚值和判断已生效的依赖。
- `services[]`：`name`、`version`、`features`（功能开关）、
  `instances[]`（`applyAfterMs` 表示推送后多久应用）、
  `dependsOn[]`（本服务依赖下游的某个新字段 `{ service, field }`）。
- `changes[]`：待推送的 `{ service, key, value }`，可选 `requires`。
- `compatibility`：每个配置键要求的版本范围（如 `>=2.3.0`）。
- `errorBudget`：`maxInstancesPerBatch`（单批最多触达的实例数）、
  `maxDegradationGapMs`（允许的"重试已升、降级未生效"风险窗口）。

## 每批允许的配置组合

- **跨服务**：同批只允许互不依赖的服务变更。上游依赖下游新字段时，
  下游批次必须**全部实例生效后**，上游批次才开始推送
  （`pushAtMs >= 下游 effectiveAtMs`）。下游字段既未应用也未计划时报错。
- **同服务**：`retry.*` 提升必须与 `degradation.enabled=true` 同批或更晚；
  降级未生效时禁止单独提升重试，风险窗口超过 `maxDegradationGapMs` 时报错。
- **版本兼容**：服务版本不满足 `compatibility` 中该键的范围时报错，不进任何批次。
- **功能开关**：`degradation.*` 只推送给 `features.degradation=true` 的服务，
  其余跳过并产生 warning。
- **错误预算**：单批实例数超过 `maxInstancesPerBatch` 时自动拆成顺序子批次。

批次生效时间 = 推送时间 + 批内最慢实例的 `applyAfterMs`（部分应用期间
该批不算生效，依赖它的批次必须等待）。

## 回滚

每个批次携带独立的 `rollback` 列表：已存在的键恢复推送前的值（`set`），
新增键删除（`delete`）。批次按序执行，某批失败时只回滚该批并停机，
后续批次标记为 `skipped`，已完成的批次不受影响。`src/executor.js`
提供了带失败注入的执行模拟（`executePlan(plan, current, { failBatchId })`）。

## 结构

- `src/version.js`：版本号解析与范围匹配。
- `src/planner.js`：依赖图构建、拓扑分层、错误预算拆批、时间窗计算、回滚计划生成。
- `src/executor.js`：批次执行/回滚模拟。
- `bin/plan.js`：CLI，读取 scenario JSON 输出计划。
- `test/planner.test.js`：node:test，覆盖部分应用、跨服务依赖、回滚等场景。
