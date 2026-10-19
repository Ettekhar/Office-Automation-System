# My Tasks — asks, requests and reminders

My Tasks is a personal inbox, not a mirror of ClickUp. Anyone can ask anyone for
something ("please check the mail"), pick the day it belongs to, and optionally
set a time — at that time the receiver's dashboard rings.

## The model

`data/assignments.json` (db.js: `getAssignments` / `createAssignment` /
`updateAssignment` / `deleteAssignment`). Deliberately **separate from `tasks`**:
`tasks` is ClickUp's mirror and `syncFromSheets.js` rewrites it, so a
hand-written ask stored there would be lost on the next sync.

```
{
  id, title, details,
  kind: 'task' | 'request' | 'reminder',
  toUserId, toUserName,          // who receives it
  fromUserId, fromUserName,      // always the session user, never the request body
  date: 'YYYY-MM-DD',            // local calendar day — "today" is the user's today
  time: 'HH:MM' | '',            // optional; empty = all day, no alarm
  remindAt: ISO | '',            // computed from date+time (local), or set by snooze
  status: 'open' | 'done' | 'dismissed',
  createdAt, updatedAt, completedAt, remindedAt, snoozeCount
}
```

## Routes (`src/server.js`)

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/master/assignments?scope=mine\|sent\|all&status=open\|done\|all` | any signed-in teammate (`all` = admins) |
| POST | `/api/master/assignments` | anyone; `toUserId` must be an active user |
| PUT | `/api/master/assignments/:id` | assignee: `status`, `remindAt`, `remindedAt`, `snoozeMinutes` only; sender/admin: full edit |
| DELETE | `/api/master/assignments/:id` | sender or admin (cancel) |

The sender is resolved from the session (`db.resolveAuthUser`), falling back to
the app's identity headers — a client can never claim to be someone else.

## Notifications and alarms

- `startAssignmentWatch()` (called from `enterApp`) polls
  `scope=mine&status=all` every 60 seconds — **including when the tab is
  hidden**, because that is when an alarm matters. Background timer throttling
  lands on roughly the same cadence.
- When `remindAt <= now` and the item is still open, the tab fires a toast, a
  three-note WebAudio chime and (if permission was granted via the "🔔 Enable
  alarms" button) a browser notification. Audio needs a user gesture first, so
  the context is primed on the first pointerdown / send.
- `localStorage['officeos_assign_fired_v1']` records `id → remindAt` so two
  open tabs do not double-ring, and so a page loaded later stays quiet about
  asks whose time passed more than 5 minutes ago.
- The My Tasks nav item carries a count badge: due today + overdue. Overdue
  turns it red.
- Snooze (+10m) moves `remindAt` and clears the fired marker for that item, so
  the new instant can ring.

Nothing is pushed when the browser is closed — alarms are dashboard-open
notifications. Web Push would need a service worker and VAPID keys.

## The page

`viewMyTasks()` in `public/master-app.js`: "MY DAY" header (due / done /
overdue), the ask form (To, What, Task-Request-Reminder, Day + Today/Tomorrow,
optional Time, note), `For me` / `I sent` tabs, and day groups (Overdue /
Today / Upcoming / Done today) with Done, Snooze and Dismiss per row. ClickUp's
mirrored work tasks are kept — folded into a `<details>` at the bottom.

## Troubleshooting

If the alarm ever misbehaves, the three things to check first are: the tick is
running (any console error in `startAssignmentWatch`), `Notification.permission`
(denied browsers still get the toast + chime), and the fired-marker map in
localStorage. Deleting `officeos_assign_fired_v1` re-arms every alarm that is
still in the past.
