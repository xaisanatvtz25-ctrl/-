#!/usr/bin/env python3
"""Writes <out>/index.html from index.template.html with cache-busting asset links."""
import os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1] if len(sys.argv) > 1 else 'dist'
v = os.environ.get('BUILD_STAMP') or time.strftime('%Y%m%d%H%M%S', time.gmtime())
t = open(os.path.join(ROOT, 'index.template.html'), encoding='utf-8').read()
t = t.replace('<script type="module" src="./src/main.tsx"></script>',
              f'<link rel="stylesheet" href="./assets/main.css?v={v}">\n    <script type="module" src="./assets/main.js?v={v}"></script>')
t = t.replace('<meta name="theme-color" content="#0f3d6a">',
              '<meta name="theme-color" content="#0f3d6a">\n'
              '    <meta property="og:title" content="ມິລະໂກະ · ສະຫຼຸບຜົນການຜະລິດ">\n'
              '    <meta property="og:description" content="ສະຫຼຸບຍອດຜະລິດລາຍເດືອນ ບໍລິສັດ ມິລະໂກະ ການຄ້າຂາເຂົ້າ-ຂາອອກ ຈຳກັດຜູ້ດຽວ">\n'
              '    <meta property="og:type" content="website">')
open(os.path.join(ROOT, out, 'index.html'), 'w', encoding='utf-8').write(t)
print('index.html', v)
