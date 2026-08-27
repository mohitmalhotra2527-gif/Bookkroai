# BookKaro ko GitHub Pages par deploy karna (3 steps)

## 1) GitHub par repo banao
- github.com → **New repository** → naam: `bookkaro` (ya jo chaho) → **Private/Public** dono chalega → **Create**.
- (Repo banaate waqt README/license add karne ki zaroorat nahi — sab already hai.)

## 2) Code push karo (project folder ke andar)

```bash
cd bookkaro-project-folder
git remote add origin https://github.com/<username>/bookkaro.git
git push -u origin main
```
(Pehla commit already ho chuka hai — `git log` se check kar sakte ho.)

## 3) Pages on karo
- Repo → **Settings → Pages → Source: GitHub Actions** select karo → Save.
- **Actions** tab mein "Deploy site to GitHub Pages" workflow khud chalega.
- 1-2 minute mein site live: `https://<username>.github.io/bookkaro/`

## Kya kaam karega, kya nahi?
| Cheez | GitHub Pages par |
|---|---|
| Landing page (homepage) | ✅ Poora kaam karega |
| Sample-question chips | ✅ Chat khulega, sawal auto-type |
| Chat ke asli jawab | ⚠️ Backend chahiye — Pages sirf static hai |

### Chat ko live karne ke 2 options
1. **Local server**: `npm install && npm run build && npm start` → phir chat page ke ⚙️ settings mein `localhost` wala URL... actually local server par site kholo hi (`http://localhost:3000`) — sab kaam karega.
2. **Apna server kahin aur deploy karo** (Render/Railway/VPS): `npm run build && npm start` + `.env` (keys) — phir GitHub Pages wale chat page ke ⚙️ settings mein apna server URL daal do. URL browser mein save hota hai (localStorage).

> ⚠️ Keys kabhi git commit nahi hui (.gitignore mein `.env` hai) — server par hi `.env` banao.
