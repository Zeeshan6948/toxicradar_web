# ToxicRadar Watch: Xcode Setup & App Store Checklist

> The Swift code in `watch-app/ToxicRadarWatch/` was written without access to Xcode/watchOS SDK,
> so it has **not been compiled**. Expect to fix small compile errors on first build.

## A. Build it in Xcode (about 20 min)

1. Install **Xcode 15+** from the Mac App Store. Sign in with your Apple ID (Xcode > Settings > Accounts).
2. **File > New > Project > watchOS > App**. Name: `ToxicRadarWatch`. Interface: SwiftUI.
   Choose **"Watch App (standalone)"**, i.e. no iPhone app required.
3. Delete the generated `ContentView.swift` and `...App.swift`, then drag in all 6 files from
   `watch-app/ToxicRadarWatch/` (tick "Copy items if needed").
4. Open `Config.swift` and set `serverURL` to your deployed https address.
5. Target > **Signing & Capabilities** > **+ Capability** > add **HealthKit**.
   Then **+ Capability** > **Background Modes** > tick **Workout Processing**
   (without this, watchOS suspends the app when you lower your wrist and readings stop).
6. Target > **Info** tab, add:
   - `Privacy - Health Share Usage Description`: *ToxicRadar reads your heart rate and HRV while you write messages to show your stress level.*
   - `Privacy - Health Update Usage Description`: *ToxicRadar starts a temporary session to receive live heart rate. Nothing is saved to Health.*
   - `Privacy - Motion Usage Description`: *Used to tell whether you are sitting still, so exercise isn't mistaken for stress.*
7. Plug in the iPhone paired with your watch, select the **watch** as run destination, press Run.
   (Needs a physical watch: the simulator has no heart-rate sensor.)
   First run: enable Developer Mode on the watch (Settings > Privacy & Security > Developer Mode).

## B. Test the full flow

1. Open ToxicRadar in the browser. `POST /api/biometrics/pair` returns a 6-digit `pairCode` (a UI button comes later).
2. On the watch: type the code, tap **Pair**, then **Start monitoring**.
3. The server receives a reading about every 5 seconds: `GET /api/biometrics/current?sessionId=...`.
4. Sit still, then walk or do jumping jacks. The reading should switch to "Not assessed (moving)".

Free signing only lasts 7 days per install. Fine for testing, not for sharing.

## C. Publishing to the App Store

| Step | Detail |
|---|---|
| Apple Developer Program | **US$99/year**: developer.apple.com/programs (no way around this for the App Store/TestFlight) |
| App Store Connect record | Bundle ID, name, category (Health & Fitness or Productivity), age rating |
| Privacy Policy URL | `https://YOUR-APP.onrender.com/privacy` (fill in the date and email first) |
| Privacy "nutrition label" | Declare **Health & Fitness data**: collected, **not linked to identity**, **not used for tracking** |
| Screenshots | Apple Watch sizes required by App Store Connect |
| Icon | 1024x1024 PNG, no transparency |
| Review notes | Paste the text below |
| Test first | Upload via Xcode (Product > Archive) to **TestFlight** and test a few days before submitting |

### Review notes (paste into App Store Connect)

```
ToxicRadar Watch sends live heart rate, HRV and resting heart rate to the user's own
ToxicRadar web session so they can see their stress level while writing messages.

HealthKit use: heart rate, HRV and resting heart rate are READ only to display stress
and are never sold, shared, or used for advertising. A temporary workout session is used
only because watchOS requires it for continuous heart rate; it is discarded and nothing
is written to Health.

How to test:
1. Open https://YOUR-APP.onrender.com on any browser and click "Connect Watch" to get a 6-digit code.
2. On the watch, enter the code and tap Pair, then Start monitoring.
3. Heart rate appears in the web app within ~5 seconds.
Demo video: [LINK]
```

### Common rejection reasons to avoid
- Missing/placeholder privacy policy or HealthKit usage strings (Guideline 5.1.3).
- Claiming a medical diagnosis. This app shows a **stress indicator only, not medical advice**; keep wording that way.
- The reviewer can't test it: the demo video + working pairing are essential.
