#!/usr/bin/env python3
# Génère les modèles Excel proposés aux fournisseurs (site/depot/modeles/), à partir des en-têtes des modèles CSV
# déjà acceptés par l'import (site/depot/modele-fabricant.csv, site/depot/stock-template.csv) : un fichier rempli
# passe tel quel dans /depot/ ou /depot/lien/. Le catalogue produit (fiches, équivalences) n'est pas encore importé :
# le fournisseur l'envoie à Central.Parts par e-mail ou WeChat.
#
# Usage : python3 tools/build-templates.py   (nécessite openpyxl ; relancer après toute modification des CSV)
# Données d'exemple fictives, marquées EXAMPLE / 示例 : aucune donnée de fournisseur réel.
import csv
import pathlib

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'site' / 'depot' / 'modeles'
HEAD = PatternFill('solid', fgColor='15171C')
REQUIRED = PatternFill('solid', fgColor='C8102E')
WHITE = Font(bold=True, color='FFFFFF')
EXAMPLE = Font(italic=True, color='8A8F98')
HINT = Font(size=9, color='4A4E57')
WRAP = Alignment(wrap_text=True, vertical='top')


def read_csv(name):
    with open(ROOT / 'site' / 'depot' / name, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.reader(f))
    return rows[0], rows[1]


def readme(wb, lines):
    ws = wb.active
    ws.title = 'Read me 说明'
    for i, (text, bold) in enumerate(lines, 1):
        c = ws.cell(row=i, column=1, value=text)
        c.alignment = WRAP
        if bold:
            c.font = Font(bold=True, size=13 if i == 1 else 11)
    ws.column_dimensions['A'].width = 120


def sheet(wb, title, columns, example, required, widths=None, hints=None, lists=None):
    ws = wb.create_sheet(title)
    for j, name in enumerate(columns, 1):
        c = ws.cell(row=1, column=j, value=name)
        c.font = WHITE
        c.fill = REQUIRED if name in required else HEAD
        ws.column_dimensions[get_column_letter(j)].width = (widths or {}).get(name, max(12, min(40, len(name) + 6)))
    first = 2
    if hints:
        for j, name in enumerate(columns, 1):
            h = ws.cell(row=2, column=j, value=hints.get(name, ''))
            h.font = HINT
            h.alignment = WRAP
        first = 3
    for j, value in enumerate(example, 1):
        ws.cell(row=first, column=j, value=value).font = EXAMPLE
    ws.freeze_panes = ws.cell(row=first, column=2)
    for name, values in (lists or {}).items():
        dv = DataValidation(type='list', formula1=f'"{values}"', allow_blank=True)
        ws.add_data_validation(dv)
        col = get_column_letter(columns.index(name) + 1)
        dv.add(f'{col}{first}:{col}20000')
    return ws


def finish(wb, path):
    # L'import (fonction import-stock) lit la première feuille : les données d'abord, le mode d'emploi ensuite.
    wb.move_sheet(wb.worksheets[0], offset=len(wb.worksheets) - 1)
    wb.active = 0
    wb.save(path)


def number(v):
    try:
        return int(v) if v.isdigit() else float(v)
    except ValueError:
        return v


# 1. Stock d'un fabricant chinois : mêmes en-têtes que modele-fabricant.csv.
cols, ex = read_csv('modele-fabricant.csv')
wb = Workbook()
readme(wb, [
    ('Central.Parts 原厂库存表模板 · Stock template for manufacturers (Chinese headers)', True),
    ('', False),
    ('填写说明（待母语人士校对）', True),
    ('1. 在「库存 Stock」表中每行填写一个型号。红色表头为必填：型号、库存。其余为选填，资料越完整，报价越容易被采购方采用。', False),
    ('2. 价格：在「价格」一列填写全部价格阶梯，例如 10~99 0.040|100~999 0.032|1000以上 0.028。也可只填一个单价。', False),
    ('3. 币种：USD、CNH（人民币）、EUR 或 HKD。', False),
    ('4. 灰色斜体为示例行，上传前请删除。', False),
    ('5. 上传：在微信公众号「Adesio Central.Parts」点击菜单「供应商」→「上传库存」，打开链接后上传本文件。', False),
    ('6. 请至少每 7 天重新上传一次，否则报价将不再向采购方展示。', False),
    ('', False),
    ('Instructions', True),
    ('1. Sheet "库存 Stock": one line per part number. Red headers are required: 型号 (part number) and 库存 (quantity).', False),
    ('2. 价格 (prices): all price breaks in one cell, e.g. 10~99 0.040|100~999 0.032|1000以上 0.028. A single unit price is also fine.', False),
    ('3. 币种 (currency): USD, CNH, EUR or HKD. Delete the grey example line before uploading.', False),
    ('4. Upload in the "Adesio Central.Parts" WeChat account: menu "供应商" → "上传库存", then tap the link. Upload again at least every 7 days.', False),
    ('5. Help: https://central.parts/depot/aide/', False),
])
sheet(wb, '库存 Stock', cols, [number(v) for v in ex], {'型号', '库存'},
      widths={'型号': 18, '产品描述': 30, '价格': 42, '规格书链接': 40, '产品链接': 40},
      lists={'币种': 'USD,CNH,EUR,HKD', '生命周期': '量产,NRND,停产,Active,NRND,LTB,Obsolete'})
OUT.mkdir(parents=True, exist_ok=True)
finish(wb, OUT / 'modele-fabricant.xlsx')

# 2. Stock, en-têtes internationaux (flux Octopart) : mêmes en-têtes que stock-template.csv.
cols, ex = read_csv('stock-template.csv')
wb = Workbook()
readme(wb, [
    ('Central.Parts stock template (English headers) · 库存表模板（英文表头）', True),
    ('', False),
    ('Instructions', True),
    ('1. Sheet "Stock": one line per part number. Red headers are required: mpn and quantity. The other columns are optional but help buyers compare offers.', False),
    ('2. Up to five price breaks: price-break-N is the minimum quantity, price-usd-N the unit price. Write the currency in "currency" (USD, CNH, EUR, HKD).', False),
    ('3. Keep the same "sku" from one upload to the next: it is the key used to update a line.', False),
    ('4. Delete the grey example line before uploading. Upload again at least every 7 days, otherwise your offers are no longer shown to buyers.', False),
    ('5. Help: https://central.parts/depot/aide/', False),
    ('', False),
    ('填写说明（待母语人士校对）', True),
    ('每行一个型号；mpn（型号）和 quantity（数量）为必填。最多五个价格阶梯：price-break-N 为最小数量，price-usd-N 为单价。上传前请删除灰色示例行，并至少每 7 天重新上传一次。', False),
])
sheet(wb, 'Stock', cols, [number(v) for v in ex], {'mpn', 'quantity'},
      widths={'manufacturer': 20, 'mpn': 18, 'description': 30, 'datasheet-url': 40, 'distributor-url': 36},
      lists={'currency': 'USD,CNH,EUR,HKD', 'lifecycle': 'Active,NRND,LTB,Obsolete'})
finish(wb, OUT / 'stock-template.xlsx')

# 3. Catalogue produit : fiches et équivalences, envoyées une fois puis à chaque changement de gamme.
wb = Workbook()
readme(wb, [
    ('Central.Parts product catalogue template · 产品目录模板', True),
    ('', False),
    ('What this file is for', True),
    ('Product information shown to European buyers next to your stock: description, datasheet, compliance, lifecycle, cross references.', False),
    ('Send it once, then only when products change. Your stock file stays separate (quantities and prices, at least every 7 days).', False),
    ('', False),
    ('How to fill it', True),
    ('1. Sheet "Products": one line per part number. Only "mpn" is required (red header). Leave a cell empty if you do not have the information.', False),
    ('2. Sheet "Cross reference": one line per equivalent part from another brand. Several lines for the same part are fine.', False),
    ('3. Lines in grey italics are examples: delete them before sending. Lists (yes/no, lifecycle…) use drop-downs.', False),
    ('4. Datasheets: a link to the PDF on your website is best; otherwise a ZIP of PDFs named by part number. Images: one per package type.', False),
    ('5. Send the file to Central.Parts by e-mail or WeChat (not on the stock upload page).', False),
    ('', False),
    ('填写说明（待母语人士校对）', True),
    ('1.「Products」表：每个型号一行，仅 mpn 为必填（红色表头），没有的信息可留空。', False),
    ('2.「Cross reference」表：每个其他品牌的替代型号一行，同一型号可有多行。', False),
    ('3. 灰色斜体为示例行，发送前请删除。规格书最好提供贵公司网站上的 PDF 链接；图片每种封装一张即可。', False),
    ('4. 请通过邮件或微信发给 Central.Parts（不要在库存上传页面上传）。', False),
])
products = ['mpn', 'category', 'description', 'package', 'datasheet_url', 'rohs', 'reach', 'halogen_free', 'lifecycle',
            'eol_date', 'packing', 'reel_qty', 'msl', 'aec_q', 'country_of_origin', 'hts_code', 'eccn', 'image_url',
            'key_parameters']
hints = {
    'mpn': 'Manufacturer part number (same as in your stock file)', 'category': 'e.g. TVS diode, MOSFET, LDO',
    'description': 'Short description: type, main values, package', 'package': 'e.g. DO-214AB (SMC), SOT-23-6',
    'datasheet_url': 'Link to the PDF datasheet', 'rohs': 'yes / no', 'reach': 'yes / no', 'halogen_free': 'yes / no',
    'lifecycle': 'Active / NRND / LTB / Obsolete', 'eol_date': 'If end of life: last-time-buy date (YYYY-MM-DD)',
    'packing': 'e.g. Tape & Reel, Tube, Tray', 'reel_qty': 'Standard pack quantity', 'msl': 'Moisture sensitivity level',
    'aec_q': 'AEC-Q100 / AEC-Q101 / AEC-Q200 / no', 'country_of_origin': 'ISO code, e.g. CN',
    'hts_code': 'Customs code, e.g. 8541.10', 'eccn': 'Export classification, e.g. EAR99',
    'image_url': 'Link to the package photo', 'key_parameters': 'Main parameters, e.g. "VRWM 5.8 V; VBR 6.8 V; PPP 1500 W"',
}
sheet(wb, 'Products', products,
      ['EXAMPLE-1.5SMC6.8CA', 'TVS diode', 'TVS diode, bidirectional, 6.8 V, 1500 W, SMC', 'DO-214AB (SMC)',
       'https://www.example.com/datasheet/1.5SMC6.8CA.pdf', 'yes', 'yes', 'yes', 'Active', '', 'Tape & Reel', 3000, '1',
       'no', 'CN', '8541.10', 'EAR99', 'https://www.example.com/img/SMC.png', 'VRWM 5.8 V; VBR 6.8 V; PPP 1500 W'],
      {'mpn'}, widths={'mpn': 20, 'description': 40, 'datasheet_url': 40, 'image_url': 30, 'key_parameters': 40},
      hints=hints,
      lists={'rohs': 'yes,no', 'reach': 'yes,no', 'halogen_free': 'yes,no', 'lifecycle': 'Active,NRND,LTB,Obsolete',
             'aec_q': 'AEC-Q100,AEC-Q101,AEC-Q200,no', 'msl': '1,2,2a,3,4,5,5a,6'})
sheet(wb, 'Cross reference', ['mpn', 'competitor_brand', 'competitor_mpn', 'equivalence', 'notes'],
      ['EXAMPLE-10N65F', 'EXAMPLE-BRAND', 'EXAMPLE-MPN', 'pin-to-pin', ''],
      {'mpn', 'competitor_brand', 'competitor_mpn'}, widths={'mpn': 20, 'competitor_brand': 22, 'competitor_mpn': 24, 'notes': 40},
      hints={'mpn': 'Your part number', 'competitor_brand': 'Other brand', 'competitor_mpn': 'Part number of the other brand',
             'equivalence': 'pin-to-pin / functional', 'notes': 'Differences, if any'},
      lists={'equivalence': 'pin-to-pin,functional'})
finish(wb, OUT / 'catalogue-produits.xlsx')
print('Modèles générés dans', OUT.relative_to(ROOT))
