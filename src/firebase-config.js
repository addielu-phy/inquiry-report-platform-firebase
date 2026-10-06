// =====================================================================
//  Firebase 設定檔（唯一需要老師修改的檔案）
// ---------------------------------------------------------------------
//  1. 到 https://console.firebase.google.com/ 建立專案。
//  2. 專案設定 → 一般 → 「你的應用程式」→ 新增「網頁應用程式 </>」。
//  3. 複製 Firebase 提供的 firebaseConfig，把下面每個「YOUR_...」換掉。
//  4. databaseURL 必須是 Realtime Database 的網址，例如：
//       https://你的專案-default-rtdb.asia-southeast1.firebasedatabase.app
//     （在 Realtime Database 頁面最上方可以看到；Firebase 給的 config 若沒有
//       databaseURL 這一行，請自己補上。）
//
//  這些值會公開在網頁原始碼中，這是 Firebase 網頁應用程式的正常設計；
//  真正保護資料的是 database.rules.json 裡的「安全性規則」與匿名登入。
//  詳細步驟請看 README.md 的「Firebase 設定教學」。
// =====================================================================

export const firebaseConfig = {
  apiKey: 'AIzaSyAEaUyp74rGLyGSNX3c7HaBHoYoZk70qFE',
  authDomain: 'inquiry-report-platform.firebaseapp.com',
  databaseURL: 'https://inquiry-report-platform-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'inquiry-report-platform',
  storageBucket: 'inquiry-report-platform.firebasestorage.app',
  messagingSenderId: '434922076327',
  appId: '1:434922076327:web:c0662c57d68d2c99c24382',
};

// 開發測試用（一般老師不用改）：連到本機 Firebase Emulator。
// 例如：{ host: '127.0.0.1', databasePort: 9000, authPort: 9099 }
// 也可以在 localhost 網址加上 ?emulator=1 臨時啟用。正式上線請保持 null。
export const firebaseEmulator = null;
