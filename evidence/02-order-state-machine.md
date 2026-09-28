```
                    POST /v1/orders
                           |
                           v
                   +---------------+
                   |   REQUESTED   |<-----------------+
                   +--+-------+----+                  |
                      |       |                        |
       accept         |       |  decline              | propose-time
       (provider)     |       |  (reason required)    | (status unchanged)
       or customer    |       |                        |
       accepts a      v       v                        |
       proposal  +-----------+ +-----------+          |
                  |  ACCEPTED | | DECLINED |          |
                  +--+-----+--+ +-----------+          |
                     |     |        terminal          |
        start job     |     |                           |
                     |     | cancel (either party)     |
                     v     +--------------+            |
              +-------------+             |            |
              | IN_PROGRESS |              |            |
              +--+-------+--+              |            |
                 |       |                 |            |
   mark done     |       |  cancel         |            |
   (status       |       |  (either party) |            |
    unchanged)   |       +-----------------+            |
                 |                                      |
                 |  confirm: customer, requires         |
                 |  providerMarkedDone = true           |
                 |                                      |
                 |  OR 72h sweep, autoCompleted = true  |
                 |                                      |
                 v                                      |
         +------------------+                           |
         |    COMPLETED     |                           |
         +--------+---------+                           |
                  |                                      |
      dispute     |  dispute (either party)              |
      (either)    |                                      |
                  v                                      |
         +------------------+   admin resolve           |
         |    DISPUTED      |   (note required)         |
         +------------------+--------------+            |
                                               |  back to COMPLETED
                                               |
                  +------------------+          |
                  |    CANCELLED     |<---------+
                  +------------------+
                    terminal
                    PR-ORDER-008
```

### Legend

| State | How it is reached | Terminal |
|---|---|---|
| `REQUESTED` | initial state, created by `POST /v1/orders` | no |
| `ACCEPTED` | provider accepted, or customer accepted a `proposedDate` | no |
| `DECLINED` | provider declined, or customer declined a proposal | yes |
| `IN_PROGRESS` | provider started the job | no |
| `COMPLETED` | customer-confirmed, or auto-completed by the 72h sweep | contested |
| `DISPUTED` | dispute raised by either party | only an Admin leaves it |
| `CANCELLED` | cancellation by either party | yes |

`CANCELLED` and `DISPUTED` are **distinct states and are not interchangeable.** A dispute raised
from `IN_PROGRESS` or `COMPLETED` goes to `DISPUTED`; a cancellation from `ACCEPTED` or
`IN_PROGRESS` goes to `CANCELLED`. `CANCELLED` is reachable from `ACCEPTED` and `IN_PROGRESS` only.
PR-ORDER-008 governs cancellation, PR-ORDER-009 governs disputes.

### Two transitions here are contested or conditional

They are deliberately not drawn as unconditional arrows.

| Transition | Why it is not a bare arrow |
|---|---|
| `COMPLETED` -> `DISPUTED` | **Disputed requirement.** PR-ORDER-009 puts `COMPLETED` in the set of states a dispute may be raised from; PR-ORDER-010 says a terminal status is never left except by the Admin dispute-resolution path, and `COMPLETED` is terminal. Unresolved - see `03-design-decisions.md` 4.1.3. |
| `IN_PROGRESS` -> `COMPLETED` | **Conditional.** By the customer only when `providerMarkedDone` is already true, or by the scheduled sweep at 72 hours, which sets `autoCompleted = true`. Neither is a plain status write (PR-ORDER-007, PR-ORDER-007a, PR-TECH-008). |
