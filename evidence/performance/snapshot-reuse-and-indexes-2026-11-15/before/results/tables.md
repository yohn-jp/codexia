| Dataset / operation | Worker status | n | App p50 ms | App p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL round trip p50 ms | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | CPU p50 ms | RSS max MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| core-long-form / snapshot.materialize.cold | complete | 1 | 268.18 | 268.18 | 412.00 | 803.00 | 803.00 | 125.87 | 6224918.00 | 184.86 | 47.55 | 0.00 | 249.53 | 181.75 |
| core-long-form / snapshot.current.warm | complete | 20 | 166.23 | 183.23 | 410.00 | 802.00 | 802.00 | 79.62 | 6224869.00 | 129.06 | 0.00 | 0.00 | 130.11 | 295.48 |
| core-long-form / snapshot.scene.current | complete | 20 | 143.25 | 166.16 | 410.00 | 802.00 | 802.00 | 80.92 | 6224869.00 | 127.65 | 0.00 | 0.00 | 93.19 | 301.76 |
| core-long-form / snapshot.pinned.first | complete | 1 | 71.88 | 71.88 | 6.00 | 2.00 | 2.00 | 15.02 | 6431932.00 | 25.20 | 0.00 | 0.00 | 68.52 | 301.20 |
| core-long-form / snapshot.reader.pinned.first | complete | 1 | 25.59 | 25.59 | 6.00 | 2.00 | 2.00 | 15.50 | 6431932.00 | 25.18 | 0.00 | 0.00 | 19.51 | 288.13 |
| core-long-form / snapshot.pinned.warm | complete | 20 | 72.25 | 82.96 | 6.00 | 2.00 | 2.00 | 14.80 | 6431932.00 | 32.86 | 0.00 | 0.00 | 67.52 | 323.00 |
| core-long-form / snapshot.scene.pinned | complete | 20 | 46.83 | 69.94 | 6.00 | 2.00 | 2.00 | 14.75 | 6431932.00 | 25.90 | 0.00 | 0.00 | 41.32 | 332.00 |
| core-long-form / knowledge.evidence.projection | complete | 1 | 0.15 | 0.15 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.15 | 301.41 |
| core-long-form / tree.retrieve | complete | 1 | 79.98 | 79.98 | 6.00 | 2.00 | 2.00 | 19.92 | 6431932.00 | 33.34 | 0.00 | 0.00 | 74.64 | 310.66 |
| core-long-form / literal.search | complete | 20 | 186.33 | 208.01 | 410.00 | 802.00 | 802.00 | 73.62 | 6224869.00 | 119.56 | 0.00 | 0.00 | 140.30 | 324.02 |
| core-long-form / writing.statistics | complete | 20 | 8588.53 | 8754.69 | 410.00 | 802.00 | 802.00 | 72.84 | 6224869.00 | 130.72 | 0.00 | 0.00 | 8554.33 | 334.57 |
| core-long-form / history.list | complete | 20 | 0.73 | 1.21 | 3.00 | 11.00 | 11.00 | 0.62 | 17231.00 | 1.13 | 0.00 | 0.00 | 0.28 | 347.46 |
| core-long-form / history.revision.bodies | complete | 20 | 2.00 | 5.62 | 13.00 | 11.00 | 11.00 | 1.80 | 17241.00 | 5.57 | 0.00 | 0.00 | 0.63 | 346.09 |
| core-long-form / document.save | complete | 20 | 2.39 | 3.09 | 12.00 | 6.00 | 8.00 | 2.16 | 5447.00 | 3.04 | 3.04 | 0.00 | 0.62 | 361.88 |
| core-long-form / mutation.snapshot.prepare | complete | 20 | 161.41 | 180.07 | 412.00 | 803.00 | 803.00 | 100.23 | 6226112.00 | 150.08 | 45.70 | 0.00 | 92.02 | 372.21 |
| core-long-form / proposal.create | complete | 20 | 100.55 | 112.38 | 411.00 | 804.00 | 804.00 | 71.04 | 3012611.00 | 112.19 | 112.19 | 0.00 | 52.60 | 357.75 |
| core-long-form / proposal.approval | complete | 20 | 1.57 | 4.77 | 5.00 | 3.00 | 3.00 | 1.40 | 6317.00 | 4.71 | 4.71 | 0.00 | 0.60 | 359.75 |
| core-long-form / operation.apply.receipt | complete | 20 | 193.16 | 223.23 | 828.00 | 1623.00 | 1625.00 | 138.36 | 6062658.00 | 223.14 | 223.14 | 0.00 | 105.27 | 357.88 |
| core-long-form / application.receipt.replay | complete | 20 | 1.31 | 1.75 | 4.00 | 11.00 | 11.00 | 1.05 | 32166.00 | 1.66 | 1.66 | 0.00 | 0.58 | 359.88 |

| Browser dataset / operation | Worker status | n | App p50 / p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | API CPU p50 ms | API RSS max MiB | Browser CPU p50 ms | Browser RSS max MiB |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

| Browser dataset / document bytes | typing frame n | p50 / p95 / p99 ms | strict IDB writes n / p95 ms | React commits | Long Tasks n / p95 ms |
| --- | ---: | --- | --- | ---: | --- |
