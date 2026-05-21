test1:
----
curl -s http://localhost:3010/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: 123456" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "thinking": {
    "type": "adaptive"
  },
  "messages": [
    {"role": "user", "content": "说一个笑话，10个字以内"}
  ]
}'

response:
---
{"id":"7d710735-0099-45a7-b26d-fac125054273","type":"message","role":"assistant","model":"claude-sonnet-4-6","stop_reason":"end_turn","s_sequence":null,"usage":{"input_tokens":32,"output_tokens":20},"content":[{"type":"text","text":"问：程序员最怕什么？\n\n答：**它能跑！*

- remark: 感觉没有输出完

test2
-----
curl -s http://localhost:3010/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: 123456" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 500
  },
  "messages": [
    {"role": "user", "content": "写一篇关于人工智能的文章"}
  ]
}'
---
{"id":"2d36613d-d88f-4c8a-ab08-6fe6376f12b2","type":"message","role":"assistant","model":"claude-sonnet-4-6","stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":38,"output_tokens":1415},"content":[{"type":"thinking","thinking":"The user wants me to write an article about artificial intelligence. They wrote in Chinese, so I should respond in Chinese.\n"},{"type":"text","text":"# 人工智能：重塑世界的技术浪潮\n\n人工智能（AI）正在以前所未有的速度渗透进我们生活的每一个角落。从手机里的语音助手，到医院里辅助诊断的影像系统，再到工厂里自主运作的机械臂，AI 早已不是科幻小说里的概念，而是实实在在改变世界的力量。\n\n## 从规则到学习：AI 的演进\n\n早期的 AI 依赖人工编写的规则——程序员把所有逻辑写死，机器按规则执行。这种方式在棋类游戏、专家系统里取得了一些成果，但面对真实世界的复杂性，很快就遇到了天花板。\n\n转折点出现在机器学习，尤其是深度学习兴起之后。机器不再依赖人工规则，而是从海量数据中自己\"学\"出规律。2012 年，深度神经网络在图像识别竞赛中大幅超越传统方法，标志着这一范式的全面胜利。此后十年，算力、数据、算法三者相互促进，推动 AI 能力呈指数级增长。\n\n2022 年前后，以 GPT 为代表的大语言模型让 AI 的能力边界再次被刷新——机器开始能够进行连贯的对话、撰写代码、分析文本，甚至展现出一定程度的推理能力。\n\n## AI 正在改变哪些领域\n\n**医疗健康**：AI 在医学影像分析上的准确率已接近甚至超过专科医生。药物研发周期因 AI 辅助的分子筛选而大幅缩短，AlphaFold 对蛋白质结构的预测更是解决了困扰生物学界数十年的难题。\n\n**软件开发**：代码补全、自动生成、漏洞检测——AI 正在成为程序员最得力的搭档。有研究显示，使用 AI 辅助工具的开发者，完成任务的速度可以提升 30% 到 50%。\n\n**教育**：个性化学习路径、即时反馈、语言学习辅助，AI 让优质教育资源的获取门槛大幅降低。\n\n**科学研究**：气候模型、材料发现、天文数据分析……AI 正在加速人类探索未知的步伐。\n\n## 不能回避的挑战\n\n技术的进步从来不是单纯的好消息。\n\n**就业结构的冲击**是最直接的担忧。重复性的脑力劳动——数据录入、基础翻译、简单客服——正在被快速替代。这不意味着大规模失业必然发生，但职业转型的压力是真实存在的，社会需要认真应对。\n\n**偏见与公平性**同样不容忽视。AI 从数据中学习，而历史数据本身就携带着人类社会的偏见。如果不加干预，AI 系统可能在招聘、信贷、司法等场景中放大歧视。\n\n**信息真实性**面临前所未有的威胁。深度伪造视频、AI 生成的虚假新闻，让\"眼见为实\"这一基本认知原则开始动摇。\n\n**自主性与控制**是更深层的问题。随着 AI 系统越来越复杂，如何确保它们的行为符合人类的价值观和意图，成为学术界和工业界共同面对的核心课题。\n\n## 技术与人的关系\n\n一个值得思考的问题是：AI 究竟是工具，还是某种意义上的\"伙伴\"？\n\n目前的 AI，无论多么强大，本质上仍是模式匹配和概率预测的产物。它没有真正的理解，没有情感，没有自我意识。但它的输出已经足够有用，足够流畅，足够让人产生\"它懂我\"的错觉。\n\n这种错觉本身并不危险，危险在于我们因此放弃了独立思考的习惯。AI 最好的使用方式，是把它当作一个知识渊博但需要被审视的助手——它能帮你更快地到达目的地，但方向盘还是要握在自己手里。\n\n## 结语\n\n人工智能是一面镜子，映照出人类的智慧，也映照出人类的局限。它能做什么、不能做什么、应该做什么，归根结底取决于我们如何定义\"好的未来\"。\n\n技术本身是中性的，但技术的走向从来不是。参与讨论、保持批判、持续学习——这是每一个生活在 AI 时代的人都值得做的事。"}]}

-remark:看起来500的budget token没有被尊重.

test3
--------
# 低 effort（应该回复很简短）
curl -s http://localhost:3010/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: 123456" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "thinking": {
    "type": "adaptive",
    "effort": "low"
  },
  "output_config": {
    "effort": "low"
  },
  "messages": [
    {"role": "user", "content": "写一篇关于人工智能的文章"}
  ]
}'
----

{"id":"a9f32e83-b6ee-427b-8b29-7eafbfbf861a","type":"message","role":"assistant","model":"claude-sonnet-4-6","stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":34,"output_tokens":1340},"content":[{"type":"thinking","thinking":"The user wants an article about artificial intelligence in Chinese.\n"},{"type":"text","text":"# 人工智能：重塑世界的技术浪潮\n\n人工智能（AI）正在以前所未有的速度渗透进我们生活的每一个角落。从手机里的语音助手，到医院里辅助诊断的影像系统，再到工厂里自主运作的机械臂——AI 不再是科幻小说里的概念，而是实实在在改变世界的力量。\n\n## 从规则到学习：AI 的进化路径\n\n早期的 AI 依赖人工编写的规则运行，能力有限，遇到规则之外的情况便束手无策。真正的突破发生在机器学习兴起之后——机器不再被告知\"怎么做\"，而是从大量数据中自己\"学会\"怎么做。\n\n深度学习的出现进一步加速了这一进程。受人类神经网络启发的多层神经网络模型，让计算机在图像识别、语音理解、自然语言处理等领域的表现迅速超越了传统方法，甚至在某些任务上超过了人类水平。\n\n近年来，以 GPT、Gemini 为代表的大语言模型（LLM）将 AI 的能力边界再次拓宽。这类模型通过海量文本训练，具备了理解上下文、生成连贯文章、编写代码、进行逻辑推理的能力，让\"通用人工智能\"的轮廓开始变得清晰。\n\n## AI 正在改变哪些领域\n\n**医疗健康**：AI 模型能在几秒内分析 CT 影像，辅助医生发现早期肿瘤；药物研发周期因 AI 的介入从数年压缩到数月。AlphaFold 对蛋白质结构的精准预测，更是直接推动了生物学研究的范式转变。\n\n**教育**：个性化学习系统可以根据每个学生的掌握程度动态调整教学内容，让因材施教真正成为可能，而不再只是一句口号。\n\n**创意产业**：AI 绘画、AI 作曲、AI 写作工具的涌现，让创作门槛大幅降低。这既是对创作者的赋能，也引发了关于版权归属和创作价值的深层讨论。\n\n**科学研究**：从气候模型的模拟，到新材料的发现，AI 正在成为科学家手中最强大的工具之一，帮助人类处理过去无法驾驭的复杂数据。\n\n## 不能回避的挑战\n\n技术的加速发展也带来了一系列严肃的问题。\n\n**就业结构的冲击**。自动化替代的不再只是体力劳动，白领工作同样面临压力。如何帮助劳动者完成技能转型，是各国政府和企业都必须正视的课题。\n\n**偏见与公平性**。AI 模型从数据中学习，而数据本身携带着人类社会的历史偏见。如果不加以干预，模型可能在招聘、信贷、司法等场景中放大歧视。\n\n**安全与滥用**。深度伪造（Deepfake）技术让虚假信息的制造成本趋近于零；自主武器系统的研发引发了国际社会对 AI 军事化的担忧。\n\n**对齐问题**。随着 AI 系统变得越来越强大，如何确保它的目标与人类价值观保持一致，成为 AI 安全领域最核心的研究方向之一。\n\n## 我们如何与 AI 共处\n\n面对 AI，恐慌和盲目乐观都不是理性的态度。更务实的做法是理解它的能力边界——AI 擅长模式识别和大规模数据处理，但在常识推理、情感理解和创造性突破上仍有明显局限。\n\n对个人而言，学会与 AI 协作是一项越来越重要的技能。把重复性、规律性的工作交给 AI，把精力集中在需要判断力、同理心和创造力的事情上，是当下最可行的应对策略。\n\n对社会而言，建立健全的 AI 治理框架——包括透明度要求、问责机制和伦理准则——是让技术红利惠及所有人而非少数人的关键。\n\n---\n\n人工智能不是终点，而是一个新的起点。它放大了人类的能力，也放大了人类的选择——我们用它来做什么，最终取决于我们自己。"}]}
-remark

-----

# 高 effort（对比用，应该回复详细）
curl -s http://localhost:3010/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: 123456" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "thinking": {
    "type": "adaptive",
    "effort": "high"
  },
  "output_config": {
    "effort": "high"
  },
  "messages": [
    {"role": "user", "content": "写一篇关于人工智能的文章"}
  ]
}'
判定：低 effort 响应明显比高 effort 短 → effort 传递有效

{"id":"5b646968-0315-4c9c-b7cc-5d97518aa3cd","type":"message","role":"assistant","model":"claude-sonnet-4-6","stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":34,"output_tokens":1293},"content":[{"type":"thinking","thinking":"The user wants me to write an article about artificial intelligence. They wrote in Chinese, so I should respond in Chinese. Let me write a thoughtful, well-structured article about AI.\n"},{"type":"text","text":"# 人工智能：重塑世界的技术浪潮\n\n## 从图灵测试到大语言模型\n\n1950年，艾伦·图灵提出了一个简单却深刻的问题：\"机器能思考吗？\"七十多年后，这个问题不再只是哲学思辨，而是每天都在影响数十亿人生活的现实。\n\n人工智能（AI）的发展并非一帆风顺。它经历过两次\"AI寒冬\"——研究经费枯竭、热情消退、质疑声四起。但每一次低谷之后，都伴随着更猛烈的反弹。2012年，深度学习在图像识别领域的突破性表现，标志着新一轮浪潮的开始。2022年，ChatGPT的发布则将这场浪潮推向了普通大众。\n\n---\n\n## 技术的核心：它究竟在做什么\n\n理解AI，需要先破除一个误解：它并不\"思考\"，至少不像人类那样思考。\n\n现代AI的核心是**统计模式识别**。大语言模型通过分析海量文本，学习词语之间的概率关系；图像识别模型通过数百万张标注图片，学习像素特征与类别之间的映射。它们的\"智能\"，本质上是对训练数据中规律的高度压缩与泛化。\n\n这既是它的力量所在，也是它的局限所在。\n\n---\n\n## 正在发生的改变\n\nAI的影响已经渗透到几乎每个行业：\n\n**医疗**：AI辅助诊断系统在某些癌症筛查任务上的准确率已超过部分专科医生。药物研发周期从十年压缩到数年。\n\n**软件开发**：代码补全、自动化测试、文档生成——开发者的工作方式正在被重新定义。有研究显示，AI辅助编程可以将某些任务的效率提升40%以上。\n\n**创意产业**：图像生成、音乐创作、视频合成……AI正在成为创作者的协作工具，同时也在挑战\"创意\"本身的定义。\n\n**教育**：个性化学习路径、即时反馈、语言学习辅助——AI有潜力让优质教育资源触达更多人。\n\n---\n\n## 不能回避的问题\n\n技术的进步从来不是中性的，AI也不例外。\n\n**就业结构的变化**是最直接的担忧。历史上每一次技术革命都消灭了旧职业，也创造了新职业。但这一次的速度更快，留给社会适应的时间更短。\n\n**偏见与公平性**同样不容忽视。AI模型从人类产生的数据中学习，也因此继承了人类社会中存在的偏见。一个用于招聘筛选的AI，可能在无意间歧视特定群体。\n\n**信息真实性**面临前所未有的挑战。深度伪造（Deepfake）技术让\"眼见为实\"成为过去式，如何在信息洪流中辨别真伪，是每个人都需要面对的新课题。\n\n**权力集中**的风险也值得警惕。训练顶尖AI模型需要巨量算力和数据，这天然地向少数科技巨头和国家集中，可能加剧全球范围内的不平等。\n\n---\n\n## 我们站在哪里\n\nAI既不是科幻小说里的终结者，也不是解决一切问题的万能钥匙。它是一种工具——极其强大、极其复杂，同时也极其依赖使用它的人的判断与价值观。\n\n真正的问题从来不是\"AI能做什么\"，而是\"我们想让它做什么\"，以及\"我们如何确保它按照我们的意愿行事\"。\n\n这需要技术人员、政策制定者、伦理学家和普通公众共同参与。AI太重要了，不能只留给工程师来决定它的走向。\n\n图灵的问题或许永远没有标准答案。但有一点是确定的：在我们试图弄清楚机器是否能思考的同时，我们也在被迫更深刻地思考——人类的思考究竟意味着什么。"}]}

-remark: 看起来effort:high并没有长多少
---
测试 4：无 thinking 的请求（回归测试）

curl -s http://localhost:3010/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: 123456" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
  "model": "claude-sonnet-4-6",
  "max_tokens": 512,
  "messages": [
    {"role": "user", "content": "你好"}
  ]
}'
---
{"id":"e1f50d7e-6e32-4b37-96cc-3771cfe27987","type":"message","role":"assistant","model":"claude-sonnet-4-6","stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":15},"content":[{"type":"text","text":"你好！有什么我可以帮你的吗？"}]}


-remark

判定：正常返回，无报错 → 不传 thinking 时不会注入空的 additionalModelRequestFields ✅

需要我帮你注释掉 XML tag 注入代码以便执行测试 1 吗？

