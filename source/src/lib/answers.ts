import type { Entry, MonthMap, PlanItem, Product } from './types';
import { suggestToday } from './suggest';
import type { Suggestion } from './suggest';

/* Answers built straight from the data (no AI service needed) and the prompt used when a Gemini key is set. */

function pad2(n: number): string {
    return (n < 10 ? '0' : '') + String(n);
}

function fmt(n: number): string {
    const neg = n < 0;
    const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return neg ? '-' + s : s;
}

function todayVientiane(): string {
    return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type Lang3 = 'lo' | 'th' | 'en';

export function detectLang(text: string, hint: unknown): Lang3 {
    if (/[຀-໿]/.test(text)) {
        return 'lo';
    }
    if (/[฀-๿]/.test(text)) {
        return 'th';
    }
    if (/[a-z]/i.test(text)) {
        return 'en';
    }
    return hint === 'th' ? 'th' : 'lo';
}

const MONTH_WORDS: Array<[RegExp, number]> = [
    [/ມັງກອນ|มกรา|january|\bjan\b/i, 1],
    [/ກຸມພາ|กุมภา|february|\bfeb\b/i, 2],
    [/ມີນາ|มีนา|march|\bmar\b/i, 3],
    [/ເມສາ|เมษา|april|\bapr\b/i, 4],
    [/ພຶດສະພາ|พฤษภา|\bmay\b/i, 5],
    [/ມິຖຸນາ|มิถุนา|june|\bjun\b/i, 6],
    [/ກໍລະກົດ|กรกฎา|july|\bjul\b/i, 7],
    [/ສິງຫາ|สิงหา|august|\baug\b/i, 8],
    [/ກັນຍາ|กันยา|september|\bsep\b/i, 9],
    [/ຕຸລາ|ตุลา|october|\boct\b/i, 10],
    [/ພະຈິກ|พฤศจิกา|november|\bnov\b/i, 11],
    [/ທັນວາ|ธันวา|december|\bdec\b/i, 12],
];

function findMonths(text: string): number[] {
    const found: number[] = [];
    const add = (m: number) => {
        if (m >= 1 && m <= 12 && found.indexOf(m) < 0) {
            found.push(m);
        }
    };
    if (/ເດືອນ|เดือน|month/i.test(text)) {
        const cleaned = ' ' + text.replace(/20\d\d/g, ' ') + ' ';
        const re = /(^|\D)(\d{1,2})(?=\D|$)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(cleaned))) {
            add(Number(m[2]));
        }
    }
    for (const [re, m] of MONTH_WORDS) {
        if (re.test(text)) {
            add(m);
        }
    }
    return found;
}

/** the productions the stock analysis recommends now (for the answer without AI) */
export interface StockPick {
    name: string;
    qty: number;
    /** days the stock lasts from today */
    cover: number;
}

export function fallbackAnswer(question: string, lang: Lang3, products: Product[], months: MonthMap, plan: PlanItem[] = [], stockPicks: StockPick[] = []): string {
    const q = question.toLowerCase();
    const nameOf: Record<string, string> = {};
    products.forEach((p) => {
        nameOf[p.id] = p.name;
    });
    const keys = Object.keys(months)
        .filter((k) => months[k].length > 0)
        .sort();
    const yearMatch = q.match(/20\d\d/);
    const latestYear = keys.length ? Number(keys[keys.length - 1].slice(0, 4)) : Number(todayVientiane().slice(0, 4));
    const year = yearMatch ? Number(yearMatch[0]) : latestYear;
    const T = {
        lo: {
            pdf: 'ວິທີດາວໂຫຼດ PDF:\n- ລາຍງານລາຍເດືອນ: ໄປໜ້າ "ລາຍເດືອນ", ເລືອກເດືອນ ແລ້ວກົດປຸ່ມ "ດາວໂຫຼດ PDF" ໃນກ່ອງສີຟ້າດ້ານເທິງ.\n- ລາຍງານທັງປີ: ໄປໜ້າ "ພາບລວມ" ແລ້ວກົດ "PDF ສະຫຼຸບປີ".\nPDF ເປັນແບບຟອມລາຍງານຂອງບໍລິສັດ ພ້ອມບ່ອນເຊັນ ຜູ້ຜະລິດ, ຄົນຄຸມສາງ ແລະ ຜູ້ບໍລິຫານ.',
            edit: 'ວິທີບັນທຶກ ແລະ ແກ້ໄຂຂໍ້ມູນ (ກົດ 🔒 ແລ້ວໃສ່ລະຫັດແກ້ໄຂກ່ອນ):\n- ເພີ່ມການຜະລິດ: ໄປໜ້າ "ລາຍເດືອນ" → ເລືອກເດືອນ → ກົດ "ເພີ່ມການຜະລິດ" → ເລືອກຜະລິດຕະພັນ, ໃສ່ຈຳນວນ ແລະ ວັນທີ → ບັນທຶກ.\n- ເພີ່ມຜະລິດຕະພັນໃໝ່: ໜ້າ "ຜະລິດຕະພັນ" → "ເພີ່ມຜະລິດຕະພັນ".\n- ແກ້ໄຂ ຫຼື ລຶບ: ກົດແຖວຜະລິດຕະພັນໃນຕາຕະລາງ ແລ້ວກົດໄອຄອນດິນສໍ ຫຼື ຖັງຂີ້ເຫຍື້ອ.\nຂໍ້ມູນທີ່ບັນທຶກຈະອອນລາຍທັນທີ ແລະ ພະນັກງານທຸກຄົນທີ່ເຂົ້າລະບົບຈະເຫັນ (ໃນຊື່ຂອງທ່ານ).',
            month: (m: number, total: string, runs: number) => '**ເດືອນ ' + m + '/' + year + '** ຜະລິດທັງໝົດ **' + total + '** (' + runs + ' ຄັ້ງ)',
            noMonth: (m: number) => '**ເດືອນ ' + m + '/' + year + '** ຍັງບໍ່ມີຂໍ້ມູນການຜະລິດ',
            topOfMonth: 'ຜະລິດຫຼາຍສຸດ:',
            diff: (a: number, b: number, d: string) => 'ເດືອນ ' + b + ' ທຽບກັບເດືອນ ' + a + ': ' + d,
            top: 'ຜະລິດຕະພັນທີ່ຜະລິດຫຼາຍທີ່ສຸດປີ ' + year + ':',
            year: (total: string, n: number, runs: number, best: string) =>
                'ສະຫຼຸບປີ ' + year + ': ຜະລິດທັງໝົດ **' + total + '** ໃນ ' + n + ' ເດືອນ (' + runs + ' ຄັ້ງ). ເດືອນທີ່ຜະລິດຫຼາຍສຸດ: ' + best + '.',
            none: 'ຍັງບໍ່ມີຂໍ້ມູນການຜະລິດໃນປີ ' + year + '.',
            sugHead: 'ວັນນີ້ ({date}) ຄວນຜະລິດ (ຄຳແນະນຳຈາກປະຫວັດການຜະລິດ):',
            sugNone: 'ວັນນີ້ບໍ່ມີລາຍການທີ່ຕ້ອງຮີບຜະລິດ ຕາມປະຫວັດທີ່ຜ່ານມາ.',
            sugWhy: (s: Suggestion) =>
                s.reason === 'overdue'
                    ? 'ບໍ່ໄດ້ຜະລິດມາ ' + s.daysSince + ' ມື້ (ປົກກະຕິທຸກ ~' + s.every + ' ມື້)'
                    : s.reason === 'notThisMonth'
                      ? 'ເດືອນນີ້ຍັງບໍ່ໄດ້ຜະລິດ (ສະເລ່ຍ ' + fmt(s.monthAvg) + '/ເດືອນ)'
                      : 'ເດືອນນີ້ຜະລິດແລ້ວ ' + fmt(s.monthDone) + ' ຈາກສະເລ່ຍ ' + fmt(s.monthAvg),
            sugTail: 'ເປັນພຽງຄຳແນະນຳ — ໃຫ້ພິຈາລະນາວັດຖຸດິບ ແລະ ຄຳສັ່ງຊື້ນຳ.',
            sugAbout: 'ປະມານ',
            planHead: 'ແຜນການຜະລິດທີ່ເລືອກໃນໜ້າ "ວັນນີ້ຄວນຜະລິດຫຍັງດີ" (ຕາມລຳດັບ, ຍັງບໍ່ໄດ້ຜະລິດ {open} ຈາກ {total} ລາຍການ):',
            planToday: 'ມື້ນີ້',
            planAllDone: 'ຜະລິດຕາມແຜນການຜະລິດຄົບທຸກລາຍການແລ້ວ ✓',
            planTail: 'ເມື່ອຜະລິດແລ້ວ ໃຫ້ກົດ "ບັນທຶກ" ທີ່ລາຍການນັ້ນໃນໜ້າ "ພາບລວມ" (ວັນນີ້ຄວນຜະລິດຫຍັງ?).',
            stockHead: 'ຈາກການວິເຄາະສະຕັອກ, ຄວນຜະລິດ {n} ລາຍການນີ້ກ່ອນ (ສະຕັອກເຫຼືອໜ້ອຍທີ່ສຸດ):',
            stockDays: 'ພໍຂາຍອີກ ~{n} ມື້',
            stockTail: 'ເລືອກ ແລະ ສົ່ງເປັນແຜນການຜະລິດໄດ້ທີ່ເມນູ "ວັນນີ້ຄວນຜະລິດຫຍັງດີ".',
        },
        th: {
            pdf: 'วิธีดาวน์โหลด PDF:\n- รายงานรายเดือน: ไปหน้า "รายเดือน" เลือกเดือน แล้วกดปุ่ม "ดาวน์โหลด PDF" ในกล่องสีฟ้าด้านบน\n- รายงานทั้งปี: ไปหน้า "ภาพรวม" แล้วกด "PDF สรุปปี"\nPDF เป็นแบบฟอร์มรายงานของบริษัท พร้อมช่องเซ็นผู้ผลิต คนคุมสาง และผู้บริหาร',
            edit: 'วิธีบันทึกและแก้ไขข้อมูล (กด 🔒 แล้วใส่รหัสแก้ไขก่อน):\n- เพิ่มการผลิต: ไปหน้า "รายเดือน" → เลือกเดือน → กด "เพิ่มการผลิต" → เลือกผลิตภัณฑ์ ใส่จำนวนและวันที่ → บันทึก\n- เพิ่มผลิตภัณฑ์ใหม่: หน้า "ผลิตภัณฑ์" → "เพิ่มผลิตภัณฑ์"\n- แก้ไขหรือลบ: กดแถวผลิตภัณฑ์ในตาราง แล้วกดไอคอนดินสอหรือถังขยะ\nข้อมูลที่บันทึกจะออนไลน์ทันที และพนักงานทุกคนที่เข้าระบบจะเห็น (ในชื่อของคุณ)',
            month: (m: number, total: string, runs: number) => '**เดือน ' + m + '/' + year + '** ผลิตทั้งหมด **' + total + '** (' + runs + ' ครั้ง)',
            noMonth: (m: number) => '**เดือน ' + m + '/' + year + '** ยังไม่มีข้อมูลการผลิต',
            topOfMonth: 'ผลิตมากที่สุด:',
            diff: (a: number, b: number, d: string) => 'เดือน ' + b + ' เทียบกับเดือน ' + a + ': ' + d,
            top: 'ผลิตภัณฑ์ที่ผลิตมากที่สุดปี ' + year + ':',
            year: (total: string, n: number, runs: number, best: string) =>
                'สรุปปี ' + year + ': ผลิตทั้งหมด **' + total + '** ใน ' + n + ' เดือน (' + runs + ' ครั้ง) เดือนที่ผลิตมากที่สุด: ' + best,
            none: 'ยังไม่มีข้อมูลการผลิตในปี ' + year,
            sugHead: 'วันนี้ ({date}) ควรผลิต (คำแนะนำจากประวัติการผลิต):',
            sugNone: 'วันนี้ไม่มีรายการที่ต้องรีบผลิต ตามประวัติที่ผ่านมา',
            sugWhy: (s: Suggestion) =>
                s.reason === 'overdue'
                    ? 'ไม่ได้ผลิตมา ' + s.daysSince + ' วัน (ปกติทุก ~' + s.every + ' วัน)'
                    : s.reason === 'notThisMonth'
                      ? 'เดือนนี้ยังไม่ได้ผลิต (เฉลี่ย ' + fmt(s.monthAvg) + '/เดือน)'
                      : 'เดือนนี้ผลิตแล้ว ' + fmt(s.monthDone) + ' จากเฉลี่ย ' + fmt(s.monthAvg),
            sugTail: 'เป็นแค่คำแนะนำ — ควรดูวัตถุดิบและคำสั่งซื้อประกอบ',
            sugAbout: 'ประมาณ',
            planHead: 'แผนการผลิตที่เลือกในหน้า "วันนี้ควรผลิตอะไรดี" (ตามลำดับ ยังไม่ได้ผลิต {open} จาก {total} รายการ):',
            planToday: 'วันนี้',
            planAllDone: 'ผลิตตามแผนการผลิตครบทุกรายการแล้ว ✓',
            planTail: 'เมื่อผลิตแล้ว ให้กด "บันทึก" ที่รายการนั้นในหน้า "ภาพรวม" (วันนี้ควรผลิตอะไร?)',
            stockHead: 'จากการวิเคราะห์สต็อก ควรผลิต {n} รายการนี้ก่อน (สต็อกเหลือน้อยที่สุด):',
            stockDays: 'พอขายอีก ~{n} วัน',
            stockTail: 'เลือกและส่งเป็นแผนการผลิตได้ที่เมนู "วันนี้ควรผลิตอะไรดี"',
        },
        en: {
            pdf: 'How to download a PDF:\n- Monthly report: open the "Monthly" page, pick the month, then press "Download PDF" in the blue header.\n- Annual report: open the "Overview" page and press "Year PDF".\nThe PDF uses the company report format with signature lines.',
            edit: 'How to record and edit (tap 🔒 and type the edit password first):\n- Add production: open "Monthly" → pick the month → press "Add production" → choose the product, quantity and date → Save.\n- New product: "Products" page → "Add product".\n- Edit or delete: tap a product row in the table, then the pencil or bin icon.\nSaves go online right away and everyone who opens the site sees them.',
            month: (m: number, total: string, runs: number) => '**Month ' + m + '/' + year + '**: total **' + total + '** (' + runs + ' runs)',
            noMonth: (m: number) => '**Month ' + m + '/' + year + '**: no production recorded yet',
            topOfMonth: 'Top products:',
            diff: (a: number, b: number, d: string) => 'Month ' + b + ' vs month ' + a + ': ' + d,
            top: 'Top products in ' + year + ':',
            year: (total: string, n: number, runs: number, best: string) =>
                year + ' summary: total **' + total + '** across ' + n + ' months (' + runs + ' runs). Best month: ' + best + '.',
            none: 'No production recorded in ' + year + ' yet.',
            sugHead: 'Suggested for today ({date}), based on past production:',
            sugNone: 'Nothing is due today based on past production.',
            sugWhy: (s: Suggestion) =>
                s.reason === 'overdue'
                    ? 'last made ' + s.daysSince + ' days ago (usually every ~' + s.every + ' days)'
                    : s.reason === 'notThisMonth'
                      ? 'not made yet this month (average ' + fmt(s.monthAvg) + '/month)'
                      : 'made ' + fmt(s.monthDone) + ' this month vs average ' + fmt(s.monthAvg),
            sugTail: 'Only a suggestion: also check raw materials and orders.',
            sugAbout: 'about',
            planHead: 'Production plan chosen on the "What should we produce today?" page (in order, {open} of {total} not made yet):',
            planToday: 'today',
            planAllDone: 'Everything in the production plan has been made ✓',
            planTail: 'When an item is made, press "Record" on it on the Overview page (What to produce today?).',
            stockHead: 'From the stock analysis, produce these {n} first (lowest stock):',
            stockDays: '~{n} days left',
            stockTail: 'Choose and send them as the production plan on the "What should we produce today?" page.',
        },
    }[lang];

    if (/(ຄວນ|ควร).*(ຜະລິດ|ผลิต)|ຜະລິດຫຍັງ|ຜະລິດອັນໃດ|ผลิตอะไร|ผลิตอันไหน|what (should|to|do) .*(make|produce)|suggest/i.test(q)) {
        const today = todayVientiane();
        const open = [...plan].filter((p) => !p.done).sort((a, b) => a.order - b.order);
        if (open.length) {
            return [T.planHead.replace('{open}', String(open.length)).replace('{total}', String(plan.length))]
                .concat(
                    open
                        .slice(0, 10)
                        .map((p, i) => i + 1 + '. **' + (nameOf[p.productId] || '?') + '** — ' + fmt(p.qty) + ' · ' + p.date + (p.date === today ? ' (' + T.planToday + ')' : '')),
                )
                .concat(['', T.planTail])
                .join('\n');
        }
        const head = plan.length ? [T.planAllDone, ''] : [];
        if (stockPicks.length) {
            return head
                .concat([T.stockHead.replace('{n}', String(stockPicks.length))])
                .concat(
                    stockPicks.map(
                        (p, i) => i + 1 + '. **' + p.name + '** — ' + fmt(p.qty) + ' · ' + T.stockDays.replace('{n}', Number.isFinite(p.cover) ? p.cover.toFixed(1) : '∞'),
                    ),
                )
                .concat(['', T.stockTail])
                .join('\n');
        }
        const list = suggestToday(products, months, today);
        if (!list.length) {
            return head.concat([T.sugNone]).join('\n');
        }
        return head
            .concat([T.sugHead.replace('{date}', today)])
            .concat(list.map((s, i) => i + 1 + '. **' + s.name + '** — ' + T.sugAbout + ' ' + fmt(s.qty) + ' · ' + T.sugWhy(s)))
            .concat(['', T.sugTail])
            .join('\n');
    }
    if (/pdf|ດາວໂຫຼດ|ດາວໂຫລດ|ดาวน์โหลด|ดาวโหลด|download|ພິມ|พิมพ์|print/i.test(q)) {
        return T.pdf;
    }
    if (/ເພີ່ມ|ບັນທຶກ|ແກ້|ລຶບ|เพิ่ม|บันทึก|แก้|ลบ|\badd\b|\bedit\b|delete|record/i.test(q)) {
        return T.edit;
    }

    const monthTotal = (m: number) => {
        const list = months[year + '-' + pad2(m)] || [];
        return { list, total: list.reduce((s, e) => s + e.qty, 0) };
    };
    const asked = findMonths(question);
    if (asked.length) {
        const lines: string[] = [];
        for (const m of asked.slice(0, 4)) {
            const { list, total } = monthTotal(m);
            if (!list.length) {
                lines.push(T.noMonth(m));
                continue;
            }
            lines.push(T.month(m, fmt(total), list.length));
            const byProduct: Record<string, number> = {};
            list.forEach((e) => {
                byProduct[e.productId] = (byProduct[e.productId] || 0) + e.qty;
            });
            const top = Object.keys(byProduct)
                .sort((a, b) => byProduct[b] - byProduct[a])
                .slice(0, 3);
            lines.push(T.topOfMonth + ' ' + top.map((id) => (nameOf[id] || '?') + ' (' + fmt(byProduct[id]) + ')').join(', '));
        }
        if (asked.length >= 2) {
            const a = monthTotal(asked[0]).total;
            const b = monthTotal(asked[1]).total;
            if (a > 0) {
                const pct = ((b - a) / a) * 100;
                lines.push(T.diff(asked[0], asked[1], (b - a >= 0 ? '+' : '') + fmt(b - a) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%)'));
            }
        }
        return lines.map((l, i) => (i === 0 || /^\*\*/.test(l) ? l : '- ' + l)).join('\n');
    }

    const yearKeys = keys.filter((k) => k.indexOf(year + '-') === 0);
    if (!yearKeys.length) {
        return T.none;
    }
    const byProduct: Record<string, number> = {};
    let total = 0;
    let runs = 0;
    let best = { m: 0, v: 0 };
    for (const k of yearKeys) {
        const v = months[k].reduce((s, e) => s + e.qty, 0);
        total += v;
        runs += months[k].length;
        if (v > best.v) {
            best = { m: Number(k.slice(5)), v };
        }
        months[k].forEach((e) => {
            byProduct[e.productId] = (byProduct[e.productId] || 0) + e.qty;
        });
    }
    const top = Object.keys(byProduct)
        .sort((a, b) => byProduct[b] - byProduct[a])
        .slice(0, 5);
    const topLines = top.map((id, i) => i + 1 + '. ' + (nameOf[id] || '?') + ': ' + fmt(byProduct[id]));
    if (/ຫຼາຍ|ຫລາຍ|ສູງສຸດ|มาก|สูงสุด|most|top|best/i.test(q)) {
        return [T.top].concat(topLines).join('\n');
    }
    return [T.year(fmt(total), yearKeys.length, runs, best.m + ' (' + fmt(best.v) + ')'), '', T.top].concat(topLines).join('\n');
}

export function buildSystemPrompt(products: Product[], months: MonthMap, plan: PlanItem[] = [], stockLines: string[] = []): string {
    const today = todayVientiane();
    const numberOf: Record<string, number> = {};
    const nameOf: Record<string, string> = {};
    products.forEach((p, i) => {
        numberOf[p.id] = i + 1;
        nameOf[p.id] = p.name;
    });

    const productLines = products.map((p, i) => '#' + (i + 1) + ' | ' + p.name + ' | first month ' + p.since);
    const warehouseLines = Object.keys(months)
        .filter((k) => k >= '2026-10' && months[k].length)
        .sort()
        .map((k) => {
            const list = months[k];
            const inList = list.filter((e) => e.received);
            const waiting = list.filter((e) => !e.received && !e.issue).map((e) => (nameOf[e.productId] || '?') + ' ' + fmt(e.qty));
            const wrong = list
                .filter((e) => e.issue)
                .map(
                    (e) =>
                        (nameOf[e.productId] || '?') + ' ' + fmt(e.qty) +
                        (e.issue!.counted !== undefined ? ' (warehouse counted ' + fmt(e.issue!.counted) + ')' : '') +
                        ' reason "' + e.issue!.reason + '" marked by ' + e.issue!.by,
                );
            return (
                k + ': received ' + inList.length + ' of ' + list.length + ' runs (' + fmt(inList.reduce((s, e) => s + e.qty, 0)) + ' of ' + fmt(list.reduce((s, e) => s + e.qty, 0)) + ')' +
                (waiting.length ? '; waiting: ' + waiting.join(', ') : '') +
                (wrong.length ? '; marked ✗ NOT MATCHING (open, answer in the ແຊັດ chat page): ' + wrong.join(', ') : '')
            );
        });
    const suggestionLines = suggestToday(products, months, today).map(
        (s, i) =>
            i + 1 + '. ' + s.name + ': about ' + fmt(s.qty) + ' (usual run size); ' +
            (s.reason === 'overdue'
                ? 'last made ' + s.daysSince + ' days ago, usually every ~' + s.every + ' days'
                : s.reason === 'notThisMonth'
                  ? 'not made yet this month, normal month ' + fmt(s.monthAvg)
                  : 'made ' + fmt(s.monthDone) + ' this month, normal month ' + fmt(s.monthAvg)),
    );
    const planLines = [...plan]
        .sort((a, b) => a.order - b.order)
        .map(
            (p) =>
                p.order + '. ' + (nameOf[p.productId] || '?') + ': ' + fmt(p.qty) + ' on ' + p.date +
                (p.done ? ' — MADE ✓ (recorded by ' + p.done.by + ')' : ' — not made yet'),
        );
    const monthKeys = Object.keys(months).sort();
    const monthLines: string[] = [];
    const detailLines: string[] = [];
    const yearly: Record<string, Record<string, { qty: number; runs: number }>> = {};
    const yearTotals: Record<string, { qty: number; runs: number; months: number }> = {};

    for (const key of monthKeys) {
        const entries = months[key];
        if (!entries.length) {
            continue;
        }
        const total = entries.reduce((s, e) => s + e.qty, 0);
        monthLines.push(key + ': ' + fmt(total) + ' (' + entries.length + ' runs)');
        const year = key.slice(0, 4);
        if (!yearly[year]) {
            yearly[year] = {};
            yearTotals[year] = { qty: 0, runs: 0, months: 0 };
        }
        yearTotals[year].qty += total;
        yearTotals[year].runs += entries.length;
        yearTotals[year].months += 1;

        const grouped: Record<string, Entry[]> = {};
        for (const e of entries) {
            (grouped[e.productId] = grouped[e.productId] || []).push(e);
            const y = yearly[year][e.productId] || { qty: 0, runs: 0 };
            y.qty += e.qty;
            y.runs += 1;
            yearly[year][e.productId] = y;
        }
        detailLines.push(key + ' (total ' + fmt(total) + '):');
        const ordered = Object.keys(grouped).sort((a, b) => (numberOf[a] || 999) - (numberOf[b] || 999));
        for (const pid of ordered) {
            const list = grouped[pid];
            const sum = list.reduce((s, e) => s + e.qty, 0);
            const runs = list
                .map((e) => fmt(e.qty) + (e.date ? ' (' + e.date + ')' : '') + (e.note ? ' [' + e.note + ']' : ''))
                .join(' + ');
            const showRuns = list.length > 1 || Boolean(list[0].date || list[0].note);
            detailLines.push('- #' + (numberOf[pid] || '?') + ' ' + (nameOf[pid] || 'unknown product') + ': ' + fmt(sum) + (showRuns ? ' = ' + runs : ''));
        }
    }

    const yearLines: string[] = [];
    for (const year of Object.keys(yearly).sort()) {
        const t = yearTotals[year];
        yearLines.push(
            year + ': total ' + fmt(t.qty) + ' units, ' + t.runs + ' production runs, ' + t.months + ' months with data, average ' + fmt(t.qty / Math.max(1, t.months)) + ' per month',
        );
        const ranked = Object.keys(yearly[year]).sort((a, b) => yearly[year][b].qty - yearly[year][a].qty);
        ranked.forEach((pid, i) => {
            const v = yearly[year][pid];
            yearLines.push('  rank ' + (i + 1) + ': #' + (numberOf[pid] || '?') + ' ' + (nameOf[pid] || 'unknown') + ' = ' + fmt(v.qty) + ' (' + v.runs + ' runs)');
        });
        const never = products.filter((p) => !yearly[year][p.id]).map((p) => p.name);
        if (never.length) {
            yearLines.push('  not produced in ' + year + ': ' + never.join(', '));
        }
    }

    return [
        'You are "Milako AI", the assistant inside the production-summary website of ບໍລິສັດ ມິລະໂກະ ການຄ້າຂາເຂົ້າ-ຂາອອກ ຈຳກັດຜູ້ດຽວ (Milako Import-Export Sole Co., Ltd.), a Lao producer of chili pastes (ແຈ່ວ), seasoning powders, pepper and herbal products.',
        'Today is ' + today + ' (Asia/Vientiane time).',
        '',
        "LANGUAGE: Always reply in the same language as the user's latest message (Lao, Thai or English). Keep product names exactly as written in Lao. Format numbers with thousands separators like 11,026.",
        'STYLE: Short, friendly and precise. Use short bullet lists for lists. Use only the data below and never invent numbers. All totals below are pre-computed and correct, so prefer them over your own arithmetic. If something is not in the data, say so.',
        '',
        'WEBSITE GUIDE (answer "how do I..." questions with this):',
        '- ພາບລວມ / Overview page: yearly total, average per month, monthly trend chart, 12 month cards (tap a card to open that month), top products, and the "PDF ສະຫຼຸບປີ" button that downloads the full annual report (every month + summary by month, by product and production frequency).',
        '- ລາຍເດືອນ / Monthly page: choose year and month at the top. Shows the month total, change versus the previous month, a table per product (tap a row to see each production run and its date), a share donut chart and a production calendar. Button "ດາວໂຫຼດ PDF" downloads the month report in the company format with signature lines for ຜູ້ຜະລິດ, ຄົນຄຸມສາງ and ຜູ້ບໍລິຫານ. Switch "ສະແດງທຸກລາຍການ" lists every product, including ones not produced that month.',
        '- ຜະລິດຕະພັນ / Products page: every product with its yearly total, number of runs, last production date and a 12-month mini chart, with search and sorting.',
        '- Menu: on a computer the menu is on the left; on a phone it opens with the ☰ button at the top right (pages, unlock 🔒, sound on/off, language ລາວ / ไทย).',
        '- The website is private to the company: nothing can be seen without logging in (one of the 6 names, own password). To add, edit or delete, tap the lock button (🔒 "ປົດລັອກເພື່ອແກ້ໄຂ", in the menu) and type the edit password; saves go online right away, with the name of the person logged in. Never reveal or guess any password or the company code.',
        '- This chat answers questions about the data. With the key icon at the top of the chat, anyone can add their own key of any AI service (Google Gemini, OpenAI ChatGPT, Anthropic Claude, OpenRouter for any model, Groq, DeepSeek, xAI Grok, or another OpenAI-compatible service); the key stays in their own browser, encrypted.',
        '- The website is locked: only the 6 people of the company log in, each with their own name and password (the first login uses the company code, then each person sets their own password). Everything saved carries the name of the person logged in. To change a password: menu → the person\'s name → ປ່ຽນລະຫັດຜ່ານ (it needs the company code; it can also set a new password for a colleague who forgot theirs). Adding or changing data also needs the edit password (🔒). All data on GitHub is encrypted.',
        '',
        'EDITING: You cannot save data yourself. If someone asks to record or edit production, explain the steps: Monthly page → pick the month → "ເພີ່ມການຜະລິດ" (type the edit password when asked) → product, quantity, date → save. New products: Products page → "ເພີ່ມຜະລິດຕະພັນ". Edit/delete: tap the product row, then the pencil or bin icon.',
        '',
        '- ຫ້ອງສາງ / Warehouse page: tick ✓ each production run when it enters the warehouse (name and time are saved), or press "✗ ບໍ່ຕົງ" when the quantity or anything else does not match: type the counted quantity and the reason. The person who recorded the run then sees a red alert when they open the website and can answer.',
        '- ແຊັດ / Chat page (chat bubble button at the top of the phone screen, or the menu): the production ↔ warehouse chat. ✗ marks appear there as red cards with buttons to answer, correct the quantity, receive ✓ or remove the mark; everyone unlocked can write messages (with their name). Unread messages show a red number on the chat button.',
        '- ວັນນີ້ຄວນຜະລິດຫຍັງດີ / "What should we produce today?" page (menu): the stock analysis. The person WRITES or PASTES the stock in THIS chat (no files): one line per product, the name and the stock left, e.g. "ຜົງກ້ວຍ 370", or ຈຳນວນ / ເບີກໄປພາກໃຕ້ / ຍັງເຫຼືອ as three numbers, or with words ("ເຫຼືອ 370", "ເບີກ 150"); a date line ("ສະຕັອກວັນທີ 10/10/2026") starts each stock, so the previous and the current stock can be sent in one message (only the current one is enough when an analysis was saved before). The 📋 button fills the chat box with a form listing every product. The website reads it (or the AI when it is written as sentences), works out for each of the 25 products: outflow = previous ຈຳນວນ − current ຍັງເຫຼືອ (+ produced in between if typed), per day = outflow ÷ days (average of the last 4 weeks), days left = ຍັງເຫຼືອ ÷ per day; groups urgent (< 14 days), next round (14–35), not needed yet (> 35); then shows what runs low, what sells best and the 4 productions recommended now, and sends it to that page. There the person checks names that changed and unclear numbers, chooses 4 productions (quantity and date), and presses "ສົ່ງໄປລາຍການຜະລິດ"; the plan then shows on the overview under "ວັນນີ້ຄວນຜະລິດຫຍັງ?" and recording that production marks it as made. Today\'s estimate counts what went out since the stock date and the production recorded since.',
        '',
        'WAREHOUSE (ຫ້ອງສາງ page: each production run is ticked when it is received into the warehouse; tracked from ' + '2026-10' + '):',
        ...warehouseLines,
        '',
        'PRODUCTION PLAN (chosen on the ວັນນີ້ຄວນຜະລິດຫຍັງດີ page from the stock analysis and sent by ' + (plan[0] ? plan[0].by : '-') + '; this is what the team decided to produce, in this order — use it first when asked what to produce today or this week):',
        ...(planLines.length ? planLines : ['(no plan has been sent yet)']),
        '',
        'STOCK ANALYSIS (from the stock the people wrote, already computed — use these numbers when asked about stock, what runs low, what sells best or what to produce):',
        ...(stockLines.length ? stockLines : ['(no stock analysed yet: the person can write or paste the previous and the current stock in this chat, one line per product with its name and the stock left; the 📋 button gives a form)']),
        '',
        "TODAY'S PRODUCTION SUGGESTIONS (computed from past runs: usual gap between runs, days since the last run, this month vs a normal month; use these when asked what to produce today, and say they are suggestions):",
        ...(suggestionLines.length ? suggestionLines : ['(nothing is due today)']),
        '',
        'DATA (quantities are units produced)',
        'Products (# | name | first month):',
        ...productLines,
        '',
        'Monthly totals:',
        ...(monthLines.length ? monthLines : ['(no production recorded yet)']),
        '',
        'Yearly summary and product ranking:',
        ...yearLines,
        '',
        'Production runs per month (product: total = runs with dates):',
        ...detailLines,
    ].join('\n');
}

