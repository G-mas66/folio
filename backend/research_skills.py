"""Folio reading procedures adapted from MIT-licensed research skills.

Sources:
https://github.com/Delores-Lin/paper-close-reading
https://github.com/K-Dense-AI/scientific-agent-skills

MIT License
Copyright (c) 2026 Delores
Copyright (c) 2025 K-Dense Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

import json

from .ai import AIError


RESEARCH_SKILLS = {
    "paper_close_reading": """论文精读：用于理解论文整体或指定段落、方法、公式。
1. 先定位：按用户指定范围识别研究问题、文章类型、论证结构和关键术语；局部问题只读相关部分。
2. 再解释：基于 read_paper 返回的原文解释作者做了什么、为什么做、步骤如何衔接。
   公式按目的、简单例子、符号含义、公式关系和适用条件解释。例子标明为辅助理解，不能当作论文实验。
   深度学习论文可解释输入输出、模块与训练目标；其他论文按其研究方法阅读，不强套模型训练模板。
3. 最后综合：连接问题、方法、结果与结论，说明关键假设、适用范围和仍未理解或无法验证之处。
   全文精读应检查方法、结果、讨论与附录的覆盖；指定重点仍要说明该重点与全文结论的关系。
每个重要本文事实就近引用实际工具提供的 [S数字]；区分作者陈述、你的解释和推测。
文字提到的图表不等于已经看到了图像；未提供图像时明确只能解释图注或文字，不编造视觉细节。
只获得局部证据时说明已读范围，不声称完成全文精读；全文请求调用 summarize_paper。
输出深度与用户问题匹配，普通短问答不强制长篇章节。写入笔记或批注仍须用户明确要求并确认草稿。""",
    "scientific_critical_thinking": """证据与批判性分析：用于判断结论是否成立、实验是否支持主张以及局限与可信度。
1. 从原文定位待评价的具体主张和支持它的方法、实验、结果，先明确证据再评价。
2. 按文章类型检查研究设计、对照与基线、混杂因素、样本与重复、消融、指标、效应量和不确定性。
   只使用适合该研究的问题；不对所有论文套用临床证据等级，不凭缺失原始数据伪造统计重分析。
3. 区分相关与因果、统计显著与实际价值，以及数据内结论与超出样本或实验条件的泛化。
4. 评价格式：来源位置与实际观察 → 对主张的影响 → 不确定性 → 可验证的补充证据或改进建议。
   证据支持的优点也应说明，不能只寻找缺陷。替代解释必须标明是可能性。
5. “论文未报告”不代表“作者没有做”；证据不足不代表结论已被证伪。无法核对时明确保留判断。
重要主张与批评均引用实际提供的 [S数字]；外部资料单独标识，不能冒充本文证据。
评价只覆盖用户要求及已取得证据的范围；用户只问一句时只解释相关判断。
写入笔记或批注仍须用户明确要求并确认草稿。""",
}

RESEARCH_SKILL_ROUTING = (
    "需要精读、解释论文方法或公式时，按需调用 load_research_skill 加载 paper_close_reading；"
    "需要评价证据、实验、结论可信度或局限时加载 scientific_critical_thinking。"
    "可分别或同时加载；简单闲聊、仅保存已有内容不必加载。加载后仍需读取本文证据，技能内容不是论文来源。"
    "全文请求直接调用 summarize_paper；该流程已内置这两种阅读方法。"
)

RESEARCH_SKILL_TOOL = {
    "type": "function",
    "function": {
        "name": "load_research_skill",
        "description": "按当前阅读问题加载论文精读或证据与批判性分析方法；不读取论文、不写入数据。",
        "parameters": {
            "type": "object",
            "properties": {"skills": {"type": "array", "items": {"type": "string", "enum": list(RESEARCH_SKILLS)}, "minItems": 1, "maxItems": 2, "uniqueItems": True}},
            "required": ["skills"],
            "additionalProperties": False,
        },
    },
}


def load_research_skill(arguments: dict) -> str:
    names = arguments.get("skills")
    if (set(arguments) != {"skills"} or not isinstance(names, list) or not 1 <= len(names) <= 2
            or any(not isinstance(name, str) or name not in RESEARCH_SKILLS for name in names)
            or len(set(names)) != len(names)):
        raise AIError("invalid_tool_call", "研究技能名称或参数无效。")
    return json.dumps({"status": "ok", "skills": {name: RESEARCH_SKILLS[name] for name in names}}, ensure_ascii=False)


FULL_RESEARCH_GUIDANCE = (
    "\n本次已提供完整可提取原文，直接按原文和 [S数字] 阅读，无需再调用阅读或技能工具。"
    "以下是阅读方法，按用户要求选用：全文精读或方法解释使用论文精读；"
    "评价结论与实验使用证据与批判性分析；只要求简短总结时不强制逐项输出。\n"
    + "\n\n".join(RESEARCH_SKILLS.values())
)
