// 质量规则：按 (ruleId, version) 注册后不可变。
// 放行结论与异常处置都必须引用具体版本，保证"当时的规则"可被还原。

export function ruleKey(ruleId, version) {
  return `${ruleId}@${version}`;
}

export function validateRule(rule) {
  if (!rule.ruleId || typeof rule.ruleId !== 'string') {
    throw new Error('质量规则缺少 ruleId');
  }
  if (!Number.isInteger(rule.version) || rule.version < 1) {
    throw new Error('质量规则 version 必须为正整数');
  }
  if (!(rule.minTemp < rule.maxTemp)) {
    throw new Error('质量规则温度上下限不合法');
  }
  if (!(rule.expectedIntervalSeconds > 0)) {
    throw new Error('质量规则缺少有效的 expectedIntervalSeconds（标称采样间隔）');
  }
  if (!(rule.maxGapMinutes >= 0)) {
    throw new Error('质量规则缺少有效的 maxGapMinutes（放行可容忍的最大缺口）');
  }
}

export function inBounds(rule, value) {
  return value >= rule.minTemp && value <= rule.maxTemp;
}

// 放行判定：存在超限即不合格；缺口累计超过规则容忍即不合格。
// 缺口不会被相邻读数补齐，只会在这里被如实计入。
export function evaluateVerdict(summary, rule) {
  const pass = summary.excursionMs === 0 && summary.gapMs <= rule.maxGapMinutes * 60_000;
  return pass ? 'pass' : 'fail';
}
