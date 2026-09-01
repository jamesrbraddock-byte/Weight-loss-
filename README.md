# Winter Diet Tracker

A tiny, dependency-free web app for tracking a weight-loss goal (120kg &rarr; 90kg by
1 April) alongside the activities and social events that affect it: golf, dog walks,
football matches (including 2-day trips), and pub nights.

## Run it

No build step, no server required.

```bash
# just open it
open index.html      # macOS
xdg-open index.html  # Linux

# or serve it locally
python3 -m http.server 8000
```

You can also host it for free on **GitHub Pages**: Settings &rarr; Pages &rarr; deploy
from the `main` branch, root folder.

## What it does

- **Daily log** — weight, whether breakfast was skipped, meal type (chicken/fish/rice/
  salad/off-plan), golf played, dog walks, pub night + drinks, football match + 2-day
  trip flag, free-text notes.
- **Dashboard** — current weight, kg to go, days left, your actual weekly rate vs the
  rate required to hit the goal date, and a projected finish date based on your recent
  trend (simple linear regression over the last ~3 weeks of weigh-ins).
- **Chart** — actual weight vs a straight-line target pace from start weight/date to
  goal weight/date.
- **This week** — quick counts of golf rounds, dog walks, pub nights, football matches.
- **Calorie guide** — a rough daily calorie target (Mifflin-St Jeor BMR + light activity)
  based on the deficit needed to stay on pace, so you know roughly what to bank on
  quiet days to cover golf Saturdays, the pub, and football trips.
- **Profile & goal settings** — editable height, age, start/goal weight and dates.
- **Export / Import** — download all data as JSON for backup, or restore from a file.
- **Reset** — wipe everything and start over.

## Data & privacy

Everything is stored in your browser's `localStorage`. Nothing is sent to a server —
there isn't one. Use **Export JSON** regularly if you want a backup, or if you plan to
switch devices/browsers (then **Import JSON** on the new one).
