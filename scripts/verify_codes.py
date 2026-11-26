"""Optional: decode generated QR codes with OpenCV (pip install opencv-python numpy).
Run from the project root: python3 scripts/verify_codes.py"""
import json, subprocess, cv2, numpy as np
texts = ['882345678901234567', 'TSUBUPAY:STORE:ABCD2345', 'hello', 'x' * 100, '日本語テスト' + 'y' * 150]
js = "const C=require('./public/lib/codes.js');console.log(JSON.stringify(%s.map(t=>C.qrMatrix(t))))" % json.dumps(texts)
mats = json.loads(subprocess.check_output(['node', '-e', js]))
ok = True
for t, m in zip(texts, mats):
    m = np.array(m, dtype=np.uint8); n = m.shape[0]
    img = np.full((n + 8, n + 8), 255, np.uint8); img[4:4 + n, 4:4 + n] = np.where(m == 1, 0, 255)
    img = cv2.resize(img, ((n + 8) * 8, (n + 8) * 8), interpolation=cv2.INTER_NEAREST)
    got, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    print(('OK  ' if got == t else 'FAIL'), f'v{(n - 17) // 4}', t[:30]); ok &= got == t
raise SystemExit(0 if ok else 1)
