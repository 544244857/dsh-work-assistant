// 工具定义的最小公共件。宿主只要求 { name, description, parameters, output:{schema, render}, execute }，
// 不需要 import @deepseek-ai/dsh-tools（在 profile 目录里解析不到）。
// 抽出来是为了让「控制面工具」和「副手工具」共用同一套写法。

export function text(summary, data) {
  return { summary, data };
}

export function outputSchema(properties) {
  return { type: 'object', properties, additionalProperties: true };
}

// render 必须返回 content 块数组，不能返回字符串：
// 宿主把 render 的结果直接当 content 用，内部会调 content.some(block => ...)，
// 返回字符串就会抛 "content.some is not a function"，工具调用整个失败。
export function renderText(value) {
  return [{ type: 'text', text: value?.summary ?? '' }];
}

export function definition(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: outputSchema(spec.output ?? {}),
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      return spec.execute(args ?? {}, exec);
    },
  };
}
