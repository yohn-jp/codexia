| Dataset / operation | Worker status | n | App p50 ms | App p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL round trip p50 ms | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | CPU p50 ms | RSS max MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| core-knowledge-dense / snapshot.materialize.cold | complete | 1 | 341.80 | 341.80 | 1406.00 | 1597.00 | 1597.00 | 275.79 | 5425097.00 | 324.71 | 32.71 | 0.00 | 185.12 | 163.55 |
| core-knowledge-dense / snapshot.current.warm | complete | 20 | 290.30 | 313.89 | 1404.00 | 1596.00 | 1596.00 | 243.82 | 5425048.00 | 306.83 | 0.00 | 0.00 | 132.67 | 200.42 |
| core-knowledge-dense / snapshot.scene.current | complete | 20 | 287.32 | 318.71 | 1404.00 | 1596.00 | 1596.00 | 248.35 | 5425048.00 | 315.35 | 0.00 | 0.00 | 116.44 | 203.43 |
| core-knowledge-dense / snapshot.pinned.first | complete | 1 | 27.07 | 27.07 | 6.00 | 2.00 | 2.00 | 14.17 | 4262572.00 | 20.40 | 0.00 | 0.00 | 35.12 | 195.16 |
| core-knowledge-dense / snapshot.reader.pinned.first | complete | 1 | 19.46 | 19.46 | 6.00 | 2.00 | 2.00 | 12.48 | 4262572.00 | 19.10 | 0.00 | 0.00 | 13.37 | 199.72 |
| core-knowledge-dense / snapshot.pinned.warm | complete | 20 | 26.64 | 34.72 | 6.00 | 2.00 | 2.00 | 12.99 | 4262572.00 | 28.70 | 0.00 | 0.00 | 22.48 | 241.86 |
| core-knowledge-dense / snapshot.scene.pinned | complete | 20 | 23.29 | 29.65 | 6.00 | 2.00 | 2.00 | 12.96 | 4262572.00 | 27.90 | 0.00 | 0.00 | 19.63 | 232.42 |
| core-knowledge-dense / knowledge.evidence.projection | complete | 1 | 0.57 | 0.57 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.57 | 204.92 |
| core-knowledge-dense / tree.retrieve | complete | 1 | 34.33 | 34.33 | 6.00 | 2.00 | 2.00 | 17.15 | 4262572.00 | 28.45 | 0.00 | 0.00 | 29.43 | 227.71 |
| core-knowledge-dense / literal.search | complete | 20 | 292.02 | 324.57 | 1404.00 | 1596.00 | 1596.00 | 246.09 | 5425048.00 | 315.14 | 0.00 | 0.00 | 124.38 | 249.51 |
| core-knowledge-dense / writing.statistics | complete | 20 | 525.90 | 573.47 | 1404.00 | 1596.00 | 1596.00 | 241.24 | 5425048.00 | 315.42 | 0.00 | 0.00 | 368.19 | 301.10 |
| core-knowledge-dense / history.list | complete | 20 | 0.68 | 1.43 | 3.00 | 6.00 | 6.00 | 0.55 | 8935.00 | 1.39 | 0.00 | 0.00 | 0.24 | 312.20 |
| core-knowledge-dense / history.revision.bodies | complete | 20 | 1.29 | 2.12 | 8.00 | 6.00 | 6.00 | 1.14 | 8940.00 | 2.06 | 0.00 | 0.00 | 0.40 | 310.95 |
| core-knowledge-dense / document.save | complete | 20 | 6.95 | 8.66 | 36.00 | 22.00 | 32.00 | 6.44 | 8840.00 | 8.62 | 8.62 | 0.00 | 1.65 | 305.96 |
| core-knowledge-dense / mutation.snapshot.prepare | complete | 20 | 289.74 | 333.89 | 1406.00 | 1597.00 | 1597.00 | 252.75 | 5441262.00 | 332.23 | 29.72 | 0.00 | 115.06 | 308.24 |
| core-knowledge-dense / proposal.create | complete | 20 | 262.24 | 300.01 | 1405.00 | 1598.00 | 1598.00 | 231.58 | 3297949.00 | 299.73 | 299.73 | 0.00 | 97.96 | 302.87 |
| core-knowledge-dense / proposal.approval | complete | 20 | 1.63 | 1.96 | 5.00 | 3.00 | 3.00 | 1.30 | 6015.00 | 1.77 | 1.77 | 0.00 | 0.56 | 303.49 |
| core-knowledge-dense / operation.apply.receipt | complete | 20 | 527.82 | 565.70 | 2840.00 | 3227.00 | 3237.00 | 467.10 | 6635250.00 | 565.59 | 565.59 | 0.00 | 205.09 | 303.21 |
| core-knowledge-dense / application.receipt.replay | complete | 20 | 1.47 | 1.73 | 4.00 | 11.00 | 11.00 | 1.18 | 30656.00 | 1.58 | 1.58 | 0.00 | 0.69 | 304.29 |

| Browser dataset / operation | Worker status | n | App p50 / p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | API CPU p50 ms | API RSS max MiB | Browser CPU p50 ms | Browser RSS max MiB |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

| Browser dataset / document bytes | typing frame n | p50 / p95 / p99 ms | strict IDB writes n / p95 ms | React commits | Long Tasks n / p95 ms |
| --- | ---: | --- | --- | ---: | --- |
