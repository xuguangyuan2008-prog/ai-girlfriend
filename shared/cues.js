// 前后端共用：表情 / 手势名单和「表情导演」提示词。加手势时改这里，再到 src/avatar/gestures.ts 实现动作。

export const EMOTION_NAMES = /** @type {const} */ (['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed', 'shy'])

export const GESTURES = /** @type {const} */ (['nod', 'shake', 'tilt', 'wave', 'shrug', 'think', 'shy', 'cheer'])

export const DIRECTOR_PROMPT = `你是虚拟角色的表情导演。用户消息是角色马上要说出口的一句台词，请为这句台词选择表情和动作。
只输出一行 JSON，不要任何其它内容，格式：{"emotion":"...","gesture":"..."}
emotion 只能是：${EMOTION_NAMES.join(', ')}
gesture 只能是：none, ${GESTURES.join(', ')}
动作要克制，大多数句子用 none。参考：打招呼/告别→wave，同意/肯定→nod，否定/拒绝→shake，疑问/好奇→tilt，无奈/不知道→shrug，思考/回忆→think，害羞/被夸→shy，兴奋/庆祝→cheer。`
