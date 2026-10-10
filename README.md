# Milako data (encrypted)

ຂໍ້ມູນຂອງເວັບສະຫຼຸບຜົນການຜະລິດ (ສາຂາ `data`). **ທຸກໄຟລ໌ຖືກເຂົ້າລະຫັດ** — ເປີດອ່ານໄດ້ສະເພາະພະນັກງານທີ່ເຂົ້າລະບົບໃນເວັບ.
ข้อมูลของเว็บสรุปการผลิต (สาขา `data`) **ทุกไฟล์ถูกเข้ารหัส** — เปิดอ่านได้เฉพาะพนักงานที่เข้าระบบในเว็บ

- `access.json` — the people who can log in (at most 6): the name, and the data key locked with that person's own password (PBKDF2-SHA256, 600,000 rounds, own salt; AES-256-GCM). No password is stored anywhere.
- `data.json` — products, production runs (who recorded them, warehouse ✓ / ✗), the production ↔ warehouse chat and the production plan.
- `history.json` — who added, changed or deleted what and when (the History page, with undo), and who set whose password.
- `stock.json` — the stock analyses of the page "ວັນນີ້ຄວນຜະລິດຫຍັງດີ" (created with the first one).
- `editor.json` — the GitHub key for saving, locked again with the edit password and with the company code.

All of these except `access.json` are encrypted with the data key (AES-256-GCM): `{"milako": "vault", "kid", "iv", "ct"}`.
Commit messages say nothing about the data. Do not edit these files by hand: everything is changed from the website.
