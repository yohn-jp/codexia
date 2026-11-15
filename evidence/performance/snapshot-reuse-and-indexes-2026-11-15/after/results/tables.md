| Dataset / operation | Worker status | n | App p50 ms | App p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL round trip p50 ms | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | CPU p50 ms | RSS max MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| core-long-form / snapshot.materialize.cold | complete | 1 | 169.82 | 169.82 | 13.00 | 803.00 | 803.00 | 49.81 | 6274919.00 | 91.82 | 48.51 | 0.00 | 203.78 | 155.95 |
| core-long-form / snapshot.current.warm | complete | 20 | 13.69 | 18.33 | 4.00 | 2.00 | 2.00 | 8.56 | 3216160.00 | 18.18 | 0.00 | 0.00 | 11.84 | 218.34 |
| core-long-form / snapshot.scene.current | complete | 20 | 13.36 | 18.63 | 4.00 | 2.00 | 2.00 | 8.06 | 3216160.00 | 18.52 | 0.00 | 0.00 | 11.33 | 216.56 |
| core-long-form / snapshot.pinned.first | complete | 1 | 14.32 | 14.32 | 3.00 | 1.00 | 1.00 | 9.69 | 3215966.00 | 14.07 | 0.00 | 0.00 | 22.11 | 173.77 |
| core-long-form / snapshot.reader.pinned.first | complete | 1 | 14.39 | 14.39 | 3.00 | 1.00 | 1.00 | 8.25 | 3215966.00 | 14.10 | 0.00 | 0.00 | 11.53 | 170.33 |
| core-long-form / snapshot.pinned.warm | complete | 20 | 14.45 | 16.24 | 3.00 | 1.00 | 1.00 | 8.70 | 3215966.00 | 16.10 | 0.00 | 0.00 | 12.74 | 216.48 |
| core-long-form / snapshot.scene.pinned | complete | 20 | 14.37 | 18.26 | 3.00 | 1.00 | 1.00 | 8.69 | 3215966.00 | 18.08 | 0.00 | 0.00 | 11.78 | 217.18 |
| core-long-form / knowledge.evidence.projection | complete | 1 | 0.17 | 0.17 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.17 | 171.38 |
| core-long-form / tree.retrieve | complete | 1 | 15.68 | 15.68 | 3.00 | 1.00 | 1.00 | 9.59 | 3215966.00 | 15.51 | 0.00 | 0.00 | 12.04 | 170.63 |
| core-long-form / literal.search | complete | 20 | 16.15 | 19.20 | 4.00 | 2.00 | 2.00 | 9.04 | 3216160.00 | 18.04 | 0.00 | 0.00 | 14.46 | 205.70 |
| core-long-form / writing.statistics | complete | 20 | 13.01 | 19.06 | 4.00 | 2.00 | 2.00 | 8.08 | 3216160.00 | 18.75 | 0.00 | 0.00 | 10.81 | 212.18 |
| core-long-form / history.list | complete | 20 | 0.72 | 0.87 | 3.00 | 11.00 | 11.00 | 0.61 | 17231.00 | 0.82 | 0.00 | 0.00 | 0.31 | 228.25 |
| core-long-form / history.revision.bodies | complete | 20 | 2.44 | 3.28 | 13.00 | 11.00 | 11.00 | 2.21 | 17241.00 | 3.22 | 0.00 | 0.00 | 0.95 | 227.00 |
| core-long-form / document.save | complete | 20 | 2.80 | 3.44 | 12.00 | 6.00 | 8.00 | 2.52 | 5447.00 | 3.38 | 3.38 | 0.00 | 0.85 | 318.61 |
| core-long-form / mutation.snapshot.prepare | complete | 20 | 102.80 | 128.20 | 13.00 | 803.00 | 803.00 | 39.69 | 6276113.00 | 75.45 | 41.62 | 0.00 | 92.84 | 320.14 |
| core-long-form / proposal.create | complete | 20 | 24.43 | 30.30 | 12.00 | 804.00 | 804.00 | 9.16 | 3062612.00 | 30.10 | 30.10 | 0.00 | 20.78 | 321.45 |
| core-long-form / proposal.approval | complete | 20 | 1.41 | 1.73 | 5.00 | 3.00 | 3.00 | 1.24 | 6317.00 | 1.66 | 1.66 | 0.00 | 0.50 | 320.45 |
| core-long-form / operation.apply.receipt | complete | 20 | 47.92 | 60.65 | 30.00 | 1623.00 | 1625.00 | 19.52 | 6162660.00 | 60.43 | 60.43 | 0.00 | 41.61 | 315.24 |
| core-long-form / application.receipt.replay | complete | 20 | 1.28 | 1.55 | 4.00 | 11.00 | 11.00 | 1.03 | 32166.00 | 1.48 | 1.48 | 0.00 | 0.58 | 316.86 |

| Browser dataset / operation | Worker status | n | App p50 / p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | API CPU p50 ms | API RSS max MiB | Browser CPU p50 ms | Browser RSS max MiB |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

| Browser dataset / document bytes | typing frame n | p50 / p95 / p99 ms | strict IDB writes n / p95 ms | React commits | Long Tasks n / p95 ms |
| --- | ---: | --- | --- | ---: | --- |
