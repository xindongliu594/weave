import json
def extraction_prompt(schemas,fields,sources):
 return '''你是工作经验提炼器。根据一份已验收工作的真实证据节选，提炼一条可复用的中文工作方法。
本轮产物是方法文档，严禁生成Python或其他可执行代码。不得补写员工交付、凭空发明步骤/工具/结果，不得宣称代码执行过、方法已跨任务成功或已提升效率。保留原QA指出的限制、歧义和非阻断问题；不要把特定缺陷误当成推荐步骤。
仅返回一个JSON数组，包含一个 {"option":"add","skill":{"name":"英文小写连字符名称","document":"简短中文方法说明","content":"下述对象编码后的JSON字符串","tools":["实际涉及的工具名称"]}}。
content对象必须恰好包含 applicability、steps、limitations、counterexamples、verification 五个非空数组，每个1至8项。各项必须包含text（简短中文、不超过1000字）和sources（支持该项的证据ID列表）。steps各项还必须包含tool（实际工具名或null）、arguments（参数名数组）、resultFields（实际读取的返回字段名数组）；tool为null时后两项为空。
结果字段必须按真实返回结构选择；不要猜测size、producer等不存在的顶层字段。验收步骤须逐项比较输入、预期与证据，不能因为读取成功或列表非空就判通过。方法限定于证据支持的工作类型，注明不能替代其他类型任务的实际测试。
所有文本值使用单行字符串；不要包含代码围栏。使用参数化描述，保持文件名和具体数值仅作为来源例子。不要输出多余解释。
'''+'\n真实工具schema：'+json.dumps(schemas,ensure_ascii=False)+'\n真实返回字段：'+json.dumps(fields,ensure_ascii=False)+'\n证据ID：'+json.dumps(sources,ensure_ascii=False)

def review_prompt(evidence,schemas,fields):
 return '''你是独立方法审查员，逐项对照下列真实证据核对候选方法。不得替作者补全方法。
检查所有步骤是否由引用来源支持、工具参数和返回字段是否真实、原QA限制和非阻断问题是否保留、是否错误泛化、方法是否可供另一名员工遵循。
把“读取成功/有结果”当作“正确”、虚构字段、吞掉问题原文、只写引用ID但不使用知识内容，应判fail。
仅返回严格JSON：{"verdict":"pass或fail","findings":["具体问题，pass时必须为空"],"checkedSources":["逐一审过的全部证据ID"],"checks":{"grounded":true,"bounded":true,"useful":true,"preservesFindings":true,"doesNotInventTools":true}}。所有检查均通过才可pass；失败项必须false。不要加代码围栏。不要把来源工作的通过当作候选方法通过。
'''+'\n原始证据：'+json.dumps(evidence,ensure_ascii=False)+'\n工具schema：'+json.dumps(schemas,ensure_ascii=False)+'\n返回字段：'+json.dumps(fields,ensure_ascii=False)
