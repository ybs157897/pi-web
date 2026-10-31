# 知识沉淀

> 由 rd-cli-ops skill 在「结合代码分析问题」完成后追加。一行一条：标题 ≤20 字，总结 ≤100 字，聚焦 `现象 → 根因 → 处理/结论`。

| 标题 | 总结 |
|------|------|
| 站点安保状态残留 | convert解绑设备后仅推安保取消通知，站点安保关系残留致中台operationStatus仍为1；结论：属中台侧问题，由中台在解绑时解除站点级安保关系，Pro侧不改码 |
| 移交成功消息显示发起人 | 成功消息正文 userName 取发起人 fromUserId 导致显示A；应传同意方 targetUserId，DMSS 同意时 Pro 上下文查不到该用户，需回调透传 name/account 兜底 |
| 服务记录站点名称为空 | 同意交付/交付失败写服务日志未带 siteName，ops-audit 按 companyId+siteId 反查在归属变更后查不到→Sites 为空；修复：上游 resolveSiteName 携带，消息体站点名兜底 |
| 待处理安保删设备仍发取消 | 删空站点调中台withdraw触发security_log，consumer按非DMSS分发handleConvertCancelSecurity且无status校验，直接发site_device_arc_cancel给安保公司；应补已生效关系判断 |
