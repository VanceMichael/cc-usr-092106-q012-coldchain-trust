// 极小的 JSON Schema 子集校验器（无第三方依赖），覆盖本仓库两个契约实际用到的关键字：
// type / required / properties / additionalProperties / items / enum / const /
// minimum / minItems / minLength / type 为 [.., "null"] 的可空写法。
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function checkType(value, type) {
  const allowed = Array.isArray(type) ? type : [type];
  // integer 可满足 number；number 不满足 integer（由后续整数检查报错）。
  const actual = typeOf(value);
  return allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
}

export function validate(schema, value, path = '$', errors = []) {
  if (schema.$schema || schema.title) {
    // 顶层文档节点，继续校验其余关键字
  }
  if (schema.type && !checkType(value, schema.type)) {
    errors.push(`${path}: 应为 ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}，实际 ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: 不在允许集合 ${JSON.stringify(schema.enum)} 内`);
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: 必须等于 ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: 小于最小值 ${schema.minimum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: 短于最小长度 ${schema.minLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: 少于最少项数 ${schema.minItems}`);
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: 缺少必填字段 ${key}`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) validate(sub, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}: 出现未声明字段 ${key}`);
      }
    }
  }
  return errors;
}

export function assertValid(schema, value) {
  const errors = validate(schema, value);
  if (errors.length) throw new Error(`证据不符合契约:\n${errors.join('\n')}`);
}
