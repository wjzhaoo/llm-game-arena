# 动物派对美术素材

本轮 21 张原画均使用 **Codex 内置 imagegen** 生成。网页使用项目内 WebP，每张小于 1 MB；不依赖生成目录。原图留在已获准的 Codex 默认目录。

- 动物图集：`public/assets/presentation/animals/`，12 张，每张 1024×1024、4×4 格，单格 256×256。
- 场景：`public/assets/presentation/scenes/`，九张，狼人杀包含昼夜两张。
- 坐标、中文状态及表现描述：`public/assets/presentation/manifest.json`。
- 全 192 格总览：`artifacts/animal-expression-overview.webp`。
- 转换工具：`scripts/pack-party-art.py`，Pillow 仅用于等格缩放、留边和 WebP 压缩，不用程序绘制替代原画。输入映射放工作区 `tmp/asset-sources.json`，任务结束后清理。

## 图集提示词

下列为猫图集完整提示词，其余 11 张仅替换动物物种、毛色和耳朵特征，保留取景、头巾、画风及表情顺序。最终风格采用用户提供的歪嘴龇牙猫参考：平面手绘、粗轮廓、大牙、夸张眼神与嘴型；参考图的文字和截图元素不进入成品。

```text
Use case: stylized-concept. Create a production expression sprite atlas for a Chinese party game. The attached image is ONLY a style and comic-attitude reference: that hilariously cheeky squinty hand-drawn cat with a giant toothy grin. DO NOT reproduce its text, screenshot, or UI. Make the animal much more absurdly expressive than a cute mascot.
ONE square 4x4 sprite sheet, exactly 16 equally sized cells on a TRUE TRANSPARENT background. Same ORANGE TABBY CAT character in every cell. Deliberately goofy internet reaction-sticker art: flat hand-drawn 2D cartoon, bold slightly wonky dark-plum outlines, simple orange/cream color blocks, almost no shading, no polished 3D, no glossy kawaii eyes. Big stupid heads, tiny paws, rubbery cartoon muzzle. Wild eyebrows, skinny squint eyes versus ping-pong eyes, ENORMOUS crooked toothy grins with visible chunky teeth, asymmetrical mouths, bulging cheeks, ridiculous attitude. Tiny teal neckerchief remains in all cells. Adult-friendly funny, shamelessly silly and mischievous. NOT merely sweet adorable emoticons.
Front-facing bust portraits. Identical head outline scale, eye baseline, crop and center registration in all 16 cells; expression can distort face INSIDE that stable silhouette. Each cell has 10% transparent padding, no overlaps, no frame lines. All ears and paws stay inside their cell.
Exact row-major expressions:
row1: CALM: deadpan relaxed tiny eyes and flat mouth; HONEST: rigidly upright, comically earnest wide-set eyes, paw on chest, awkward straight smile with TWO silly front teeth; SINCERE: leaning just slightly forward, huge imploring pupils and both paws clasped, ridiculously overcommitted smile; INNOCENT: impossibly round staring eyes, pursed lips, both paws under chin, exaggerated who-me face.
row2: ARROGANT: chin up, ultra-narrow smug side-eye, enormous slanted toothy shit-eating grin; TRIUMPHANT: eyes squeezed smugly shut, inflated cheeks, broad self-satisfied rows-of-teeth grin, tiny paws on hips; CRAFTY: narrow sideways eyes, one brow high, crooked conspiratorial toothy grin, paw rubbing chin; TAUNTING: one eye squeezed shut, big floppy tongue out, paw beckoning.
row3: THINKING: tiny crossed eyes looking up and paw squeezing chin, crooked thoughtful mouth; CONFUSED: one eye huge and one eye tiny, one brow up one down, diagonal baffled mouth; NERVOUS: tiny pupils, gritted rows of teeth, absurdly big sweat drops, paws wringing; SURPRISED: bulging eyeballs and comically huge round open mouth, paws thrown up.
row4: WRONGED: gigantic watery tear-filled eyes, trembling curled pout lip, paws clasped pleading; DEJECTED: droopy half-closed eyes, sagging cheeks and downturned wobbling mouth; ANGRY: eyebrows form a deep V, bloodshot bulging eyes, enormous clenched teeth and tiny clenched paws; HAPPY: explosive open-mouth belly laugh, squeezed crescent eyes, massive teeth, both paws up.
These must read clearly as 16 DIFFERENT exaggerated reactions at 48px. No text, no letters, no numbers, no writing, no logos, no watermark, no accessories changing, no backgrounds.

```

动物：猫（橘色虎斑）、柴犬（柴色与奶油色）、狐狸（红棕与黑耳尖）、兔子（浅灰紫与长耳）、熊猫（黑白）、棕熊（巧克力色）、浣熊（银灰与黑眼罩）、水獭（栗色与奶油色口鼻）、猫头鹰（棕色与奶油色面盘）、企鹅（黑白与橘色喙）、绵羊（奶油色羊毛）、水豚（沙棕色）。所有角色佩戴青绿色小领巾。

## 场景提示词

### xiangqi

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: Chinese xiangqi outdoor pavilion arena: a grand carved wooden Chinese chessboard sits in center foreground, smug orange cat and panicked shiba dog slap down oversized ROUND blank chess tokens; ridiculous flowing victory ribbons, peach trees and floating petals, mint and coral palette, no writing on tokens. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

### blind

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: Mischievous hidden-piece Chinese chess game in a theatrical purple tent: chibi fox peeks slyly behind a fan while a shocked panda points at a carved chessboard with round face-down blank wooden pieces, oversized question-shaped abstract squiggles without text, magenta and turquoise palette. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

### werewolf-day

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: Werewolf social deduction game DAY village square, warm sunshine, chibi rabbit loudly accuses an innocent-looking raccoon while a smug little wolf-shaped shadow belongs to no identifiable player, round debate table, cottage village, outrageous gestures, golden mint coral colors. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

### werewolf-night

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: Werewolf social deduction game NIGHT village, deep violet starry sky, enormous glowing crescent moon, crooked cozy cottages, chibi owl with a lantern and startled bunny hiding behind a bush, a playful mysterious wolf silhouette on a distant hill, teal moonlight and violet palette. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

### groupchat

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: Outrageous animal tea party in a cozy open-air cafe: chibi otter passionately talking with flippers raised, baffled sheep listening, smug orange cat sipping tea, teacups and a round discussion table, colorful speech-balloon SHAPES completely blank, floating confetti, cream coral mint palette. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

### undercover

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: Word guessing social deduction party in a colorful secret club: innocent bunny nervously holds a face-down BLANK card, fox with a comically huge magnifying glass suspiciously examines a smug raccoon, round table scattered with BLANK secret cards, coral lilac golden palette. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

### liarsdice

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: High-stakes silly liar dice party at a teal felt round table: swaggering chibi shiba slams an oversized red dice cup, stunned panda gasps at tumbling ivory dice with dark dots, orange cat grins behind another cup, flying dice and dramatic comic action swooshes, teal cherry red butter-yellow palette. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

### codenames

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: Goofy cartoon spy headquarters: orange cat secret agent with dark sunglasses and tiny earpiece gestures at a board of 25 completely BLANK rectangular golden cards, fox and penguin agents point in opposite directions with absurd confidence, red and blue spotlights, coral turquoise lavender palette, no letters on cards. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

### spyfall

```text
Use case: illustration-story. Website party game scene illustration. Wide landscape composition, bright exaggerated goofy chibi animal cartoon, thick deep plum outlines, soft tactile cel shading and painterly candy colors, bold appealing shapes. Scene: Comical secret agent interrogation in a retro travel station: suspicious capybara in a tiny trench coat holding a BLANK passport while nervous raccoon tries to look casual, owl detective with giant magnifying glass, colorful travel suitcases and wall MAP with abstract shapes only, mint yellow violet palette. Original artwork for an adult-friendly silly animal party game, expressive and theatrical, polished charming comic book splash art, no interface controls. Keep the most important animals and props in the RIGHT TWO THIRDS, left third has airy simple atmosphere so HTML headline can overlay; top edge and bottom edge can crop gracefully. No letters, no words, no numbers, no logos, no watermark. Do not include any text.
```

## 使用约束

表情是玩家主动表演的状态，不代表真实情绪或可信度。动物分配与隐藏身份、模型品牌无关。图内不含文字，中文标签由 HTML 显示。素材失效时保留昵称、席位和状态文字。旧记录缺失形象数据时显示“未记录”。
