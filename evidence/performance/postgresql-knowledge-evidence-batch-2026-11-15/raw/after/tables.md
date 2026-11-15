| Dataset / operation | Worker status | n | App p50 ms | App p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL round trip p50 ms | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | CPU p50 ms | RSS max MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| core-knowledge-dense / snapshot.materialize.cold | complete | 1 | 124.07 | 124.07 | 136.00 | 1597.00 | 1597.00 | 69.76 | 5440631.00 | 104.12 | 33.95 | 0.00 | 120.28 | 152.82 |
| core-knowledge-dense / snapshot.current.warm | complete | 20 | 73.91 | 78.97 | 134.00 | 1596.00 | 1596.00 | 44.68 | 5440582.00 | 71.23 | 0.00 | 0.00 | 60.13 | 204.87 |
| core-knowledge-dense / snapshot.scene.current | complete | 20 | 69.58 | 80.61 | 134.00 | 1596.00 | 1596.00 | 43.98 | 5440582.00 | 75.36 | 0.00 | 0.00 | 54.90 | 207.78 |
| core-knowledge-dense / snapshot.pinned.first | complete | 1 | 31.05 | 31.05 | 6.00 | 2.00 | 2.00 | 18.07 | 4262572.00 | 24.20 | 0.00 | 0.00 | 33.44 | 202.61 |
| core-knowledge-dense / snapshot.reader.pinned.first | complete | 1 | 22.63 | 22.63 | 6.00 | 2.00 | 2.00 | 16.18 | 4262572.00 | 22.26 | 0.00 | 0.00 | 12.86 | 205.17 |
| core-knowledge-dense / snapshot.pinned.warm | complete | 20 | 28.74 | 33.47 | 6.00 | 2.00 | 2.00 | 16.32 | 4262572.00 | 27.88 | 0.00 | 0.00 | 21.55 | 242.13 |
| core-knowledge-dense / snapshot.scene.pinned | complete | 20 | 26.11 | 32.40 | 6.00 | 2.00 | 2.00 | 16.29 | 4262572.00 | 28.18 | 0.00 | 0.00 | 17.51 | 233.25 |
| core-knowledge-dense / knowledge.evidence.projection | complete | 1 | 0.58 | 0.58 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.59 | 202.16 |
| core-knowledge-dense / tree.retrieve | complete | 1 | 28.34 | 28.34 | 6.00 | 2.00 | 2.00 | 16.04 | 4262572.00 | 22.09 | 0.00 | 0.00 | 20.95 | 210.16 |
| core-knowledge-dense / literal.search | complete | 20 | 73.64 | 76.95 | 134.00 | 1596.00 | 1596.00 | 43.13 | 5440582.00 | 67.88 | 0.00 | 0.00 | 49.79 | 238.84 |
| core-knowledge-dense / writing.statistics | complete | 20 | 328.72 | 342.92 | 134.00 | 1596.00 | 1596.00 | 43.40 | 5440582.00 | 69.96 | 0.00 | 0.00 | 324.83 | 287.25 |
| core-knowledge-dense / history.list | complete | 20 | 0.59 | 0.91 | 3.00 | 6.00 | 6.00 | 0.50 | 8935.00 | 0.86 | 0.00 | 0.00 | 0.21 | 325.92 |
| core-knowledge-dense / history.revision.bodies | complete | 20 | 1.24 | 1.73 | 8.00 | 6.00 | 6.00 | 1.12 | 8940.00 | 1.69 | 0.00 | 0.00 | 0.37 | 327.17 |
| core-knowledge-dense / document.save | complete | 20 | 6.96 | 8.51 | 36.00 | 22.00 | 32.00 | 6.49 | 8840.00 | 8.44 | 8.44 | 0.00 | 1.65 | 328.42 |
| core-knowledge-dense / mutation.snapshot.prepare | complete | 20 | 82.38 | 86.08 | 136.00 | 1597.00 | 1597.00 | 57.73 | 5456796.00 | 84.23 | 31.50 | 0.00 | 51.47 | 300.20 |
| core-knowledge-dense / proposal.create | complete | 20 | 52.81 | 56.87 | 135.00 | 1598.00 | 1598.00 | 34.69 | 3313483.00 | 56.68 | 56.68 | 0.00 | 38.48 | 300.96 |
| core-knowledge-dense / proposal.approval | complete | 20 | 1.70 | 4.57 | 5.00 | 3.00 | 3.00 | 1.41 | 6015.00 | 4.49 | 4.49 | 0.00 | 0.60 | 292.94 |
| core-knowledge-dense / operation.apply.receipt | complete | 20 | 110.52 | 117.66 | 300.00 | 3227.00 | 3237.00 | 75.19 | 6666318.00 | 117.59 | 117.59 | 0.00 | 77.34 | 297.75 |
| core-knowledge-dense / application.receipt.replay | complete | 20 | 1.50 | 2.72 | 4.00 | 11.00 | 11.00 | 1.21 | 30656.00 | 2.63 | 2.63 | 0.00 | 0.69 | 293.60 |

| Browser dataset / operation | Worker status | n | App p50 / p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | API CPU p50 ms | API RSS max MiB | Browser CPU p50 ms | Browser RSS max MiB |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

| Browser dataset / document bytes | typing frame n | p50 / p95 / p99 ms | strict IDB writes n / p95 ms | React commits | Long Tasks n / p95 ms |
| --- | ---: | --- | --- | ---: | --- |
