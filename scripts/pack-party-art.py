"""Pack built-in Codex outputs into bounded, local game assets (Pillow)."""
import json
from io import BytesIO
from pathlib import Path
from uuid import uuid4
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'tmp' / 'asset-sources.json'
OUT = ROOT / 'public' / 'assets' / 'presentation'


def bounded_webp(image, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    for quality in [88, 82, 75, 68]:
        encoded = BytesIO()
        image.save(encoded, 'WEBP', quality=quality, method=6)
        if encoded.tell() <= 1_000_000:
            # Browsers and validation must never observe a partially encoded atlas.
            temporary = ROOT / 'tmp' / ('party-art-' + uuid4().hex + '.webp')
            temporary.parent.mkdir(exist_ok=True)
            temporary.write_bytes(encoded.getvalue())
            temporary.replace(target)
            return
    raise ValueError(f'Asset exceeds 1 MB: {target}')


def main():
    sources = json.loads(SOURCES.read_text(encoding='utf-8-sig'))
    for name, source in sources.items():
        existing = OUT / ('scenes' if name.startswith('scene-') else 'animals') / ((name[6:] if name.startswith('scene-') else name) + '.webp')
        if existing.exists() and existing.stat().st_mtime > Path(source).stat().st_mtime:
            continue
        image = Image.open(source).convert('RGBA')
        if name.startswith('scene-'):
            image.thumbnail((1600, 1000), Image.Resampling.LANCZOS)
            target = OUT / 'scenes' / (name[6:] + '.webp')
        else:
            # Keep the original equal-cell alignment; no per-expression face tracking.
            atlas = Image.new('RGBA', (1024, 1024))
            w, h = image.size
            for row in range(4):
                for col in range(4):
                    cell = image.crop((round(col*w/4), round(row*h/4), round((col+1)*w/4), round((row+1)*h/4)))
                    cell = cell.resize((240, 240), Image.Resampling.LANCZOS)
                    atlas.alpha_composite(cell, (col*256+8, row*256+8))
            image = atlas
            target = OUT / 'animals' / (name + '.webp')
        bounded_webp(image, target)
        print(f'{name}: {image.width}x{image.height}, {target.stat().st_size} bytes')
    overview()


def overview():
    manifest_path = OUT / 'manifest.json'
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 16)
    small = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 13)
    sheet = Image.new('RGB', (1456, 1160), '#fff7e9')
    draw = ImageDraw.Draw(sheet)
    draw.text((20, 14), '动物派对 · 12 位角色 × 16 种状态', fill='#3d2a50', font=font)
    for i, state in enumerate(manifest['states']):
        draw.text((104+i*84, 52), state['label'], fill='#3d2a50', font=small)
    for j, animal in enumerate(manifest['animals']):
        path = ROOT / 'public' / animal['src'].lstrip('/')
        if not path.exists():
            continue
        atlas = Image.open(path).convert('RGBA')
        y = 82+j*88
        draw.text((16, y+26), animal['label'], fill='#3d2a50', font=font)
        for i in range(16):
            x = 94+i*84
            cell = atlas.crop((i%4*256, i//4*256, (i%4+1)*256, (i//4+1)*256)).resize((80, 80), Image.Resampling.LANCZOS)
            sheet.paste(cell, (x, y), cell)
    artifact = ROOT / 'artifacts' / 'animal-expression-overview.webp'
    artifact.parent.mkdir(exist_ok=True)
    bounded_webp(sheet, artifact)


if __name__ == '__main__':
    main()
