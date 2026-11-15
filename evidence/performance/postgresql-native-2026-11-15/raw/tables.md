| Dataset / operation | Worker status | n | App p50 ms | App p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL round trip p50 ms | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | CPU p50 ms | RSS max MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| core-knowledge-dense / snapshot.materialize.cold | complete | 1 | 386.74 | 386.74 | 1406.00 | 1597.00 | 1597.00 | 314.28 | 5425097.00 | 368.34 | 31.52 | 0.00 | 209.50 | 161.23 |
| core-knowledge-dense / snapshot.current.warm | complete | 20 | 281.66 | 331.50 | 1404.00 | 1596.00 | 1596.00 | 238.98 | 5425048.00 | 325.18 | 0.00 | 0.00 | 123.78 | 193.74 |
| core-knowledge-dense / snapshot.scene.current | complete | 20 | 271.36 | 327.14 | 1404.00 | 1596.00 | 1596.00 | 236.19 | 5425048.00 | 320.67 | 0.00 | 0.00 | 121.58 | 195.03 |
| core-knowledge-dense / snapshot.pinned.first | complete | 1 | 33.35 | 33.35 | 6.00 | 2.00 | 2.00 | 13.75 | 4262572.00 | 24.07 | 0.00 | 0.00 | 30.35 | 204.71 |
| core-knowledge-dense / snapshot.reader.pinned.first | complete | 1 | 20.05 | 20.05 | 6.00 | 2.00 | 2.00 | 13.60 | 4262572.00 | 19.66 | 0.00 | 0.00 | 23.55 | 206.33 |
| core-knowledge-dense / snapshot.pinned.warm | complete | 20 | 26.43 | 31.19 | 6.00 | 2.00 | 2.00 | 12.33 | 4262572.00 | 25.18 | 0.00 | 0.00 | 22.31 | 225.92 |
| core-knowledge-dense / snapshot.scene.pinned | complete | 20 | 23.20 | 27.37 | 6.00 | 2.00 | 2.00 | 12.40 | 4262572.00 | 24.88 | 0.00 | 0.00 | 18.44 | 233.17 |
| core-knowledge-dense / knowledge.evidence.projection | complete | 1 | 0.56 | 0.56 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.56 | 222.12 |
| core-knowledge-dense / tree.retrieve | complete | 1 | 26.97 | 26.97 | 6.00 | 2.00 | 2.00 | 12.79 | 4262572.00 | 20.72 | 0.00 | 0.00 | 22.50 | 237.12 |
| core-knowledge-dense / literal.search | complete | 20 | 267.48 | 293.71 | 1404.00 | 1596.00 | 1596.00 | 226.13 | 5425048.00 | 284.43 | 0.00 | 0.00 | 116.35 | 250.21 |
| core-knowledge-dense / writing.statistics | complete | 20 | 526.02 | 551.71 | 1404.00 | 1596.00 | 1596.00 | 247.10 | 5425048.00 | 309.66 | 0.00 | 0.00 | 357.32 | 315.11 |
| core-knowledge-dense / history.list | complete | 20 | 0.60 | 1.08 | 3.00 | 6.00 | 6.00 | 0.51 | 8935.00 | 1.00 | 0.00 | 0.00 | 0.24 | 331.36 |
| core-knowledge-dense / history.revision.bodies | complete | 20 | 1.42 | 5.24 | 8.00 | 6.00 | 6.00 | 1.29 | 8940.00 | 5.19 | 0.00 | 0.00 | 0.51 | 330.24 |
| core-knowledge-dense / document.save | complete | 20 | 7.94 | 8.84 | 36.00 | 22.00 | 32.00 | 7.32 | 8840.00 | 8.73 | 8.73 | 0.00 | 2.14 | 308.75 |
| core-knowledge-dense / mutation.snapshot.prepare | complete | 20 | 301.32 | 331.37 | 1406.00 | 1597.00 | 1597.00 | 262.80 | 5441262.00 | 329.87 | 29.49 | 0.00 | 122.44 | 310.23 |
| core-knowledge-dense / proposal.create | complete | 20 | 283.04 | 307.50 | 1405.00 | 1598.00 | 1598.00 | 250.17 | 3297949.00 | 307.05 | 307.05 | 0.00 | 113.55 | 305.50 |
| core-knowledge-dense / proposal.approval | complete | 20 | 1.45 | 1.75 | 5.00 | 3.00 | 3.00 | 1.18 | 6015.00 | 1.61 | 1.61 | 0.00 | 0.54 | 307.38 |
| core-knowledge-dense / operation.apply.receipt | complete | 20 | 527.56 | 615.80 | 2840.00 | 3227.00 | 3237.00 | 464.04 | 6635250.00 | 615.69 | 615.69 | 0.00 | 213.61 | 305.10 |
| core-knowledge-dense / application.receipt.replay | complete | 20 | 1.24 | 1.61 | 4.00 | 11.00 | 11.00 | 1.00 | 30656.00 | 1.47 | 1.47 | 0.00 | 0.59 | 306.98 |
| core-limit-999 / snapshot.materialize.boundary | complete | 1 | 686.43 | 686.43 | 1011.00 | 2001.00 | 2001.00 | 248.08 | 6380209.00 | 352.59 | 63.17 | 0.00 | 661.67 | 186.70 |
| core-long-form / snapshot.materialize.cold | complete | 1 | 276.82 | 276.82 | 412.00 | 803.00 | 803.00 | 120.67 | 6224918.00 | 177.29 | 50.42 | 0.00 | 276.34 | 174.49 |
| core-long-form / snapshot.current.warm | complete | 20 | 156.92 | 184.95 | 410.00 | 802.00 | 802.00 | 76.51 | 6224869.00 | 122.98 | 0.00 | 0.00 | 122.23 | 323.50 |
| core-long-form / snapshot.scene.current | complete | 20 | 124.52 | 165.08 | 410.00 | 802.00 | 802.00 | 74.91 | 6224869.00 | 121.42 | 0.00 | 0.00 | 81.13 | 329.77 |
| core-long-form / snapshot.pinned.first | complete | 1 | 68.71 | 68.71 | 6.00 | 2.00 | 2.00 | 14.40 | 6431932.00 | 22.43 | 0.00 | 0.00 | 65.18 | 324.57 |
| core-long-form / snapshot.reader.pinned.first | complete | 1 | 22.95 | 22.95 | 6.00 | 2.00 | 2.00 | 14.67 | 6431932.00 | 22.58 | 0.00 | 0.00 | 16.60 | 324.51 |
| core-long-form / snapshot.pinned.warm | complete | 20 | 71.55 | 80.51 | 6.00 | 2.00 | 2.00 | 14.98 | 6431932.00 | 29.01 | 0.00 | 0.00 | 66.99 | 344.71 |
| core-long-form / snapshot.scene.pinned | complete | 20 | 46.70 | 66.45 | 6.00 | 2.00 | 2.00 | 15.25 | 6431932.00 | 25.61 | 0.00 | 0.00 | 40.47 | 361.90 |
| core-long-form / knowledge.evidence.projection | complete | 1 | 0.19 | 0.19 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.15 | 325.38 |
| core-long-form / tree.retrieve | complete | 1 | 68.53 | 68.53 | 6.00 | 2.00 | 2.00 | 15.19 | 6431932.00 | 23.41 | 0.00 | 0.00 | 63.51 | 325.51 |
| core-long-form / literal.search | complete | 20 | 194.16 | 223.37 | 410.00 | 802.00 | 802.00 | 83.36 | 6224869.00 | 122.47 | 0.00 | 0.00 | 139.79 | 323.63 |
| core-long-form / writing.statistics | complete | 20 | 8172.96 | 8233.82 | 410.00 | 802.00 | 802.00 | 78.23 | 6224869.00 | 123.41 | 0.00 | 0.00 | 8117.89 | 320.73 |
| core-long-form / history.list | complete | 20 | 0.66 | 2.13 | 3.00 | 11.00 | 11.00 | 0.56 | 17231.00 | 2.09 | 0.00 | 0.00 | 0.25 | 331.98 |
| core-long-form / history.revision.bodies | complete | 20 | 1.85 | 2.56 | 13.00 | 11.00 | 11.00 | 1.71 | 17241.00 | 2.53 | 0.00 | 0.00 | 0.56 | 333.35 |
| core-long-form / document.save | complete | 20 | 2.54 | 3.07 | 12.00 | 6.00 | 8.00 | 2.35 | 5447.00 | 3.03 | 3.03 | 0.00 | 0.70 | 332.44 |
| core-long-form / mutation.snapshot.prepare | complete | 20 | 162.82 | 183.86 | 412.00 | 803.00 | 803.00 | 94.46 | 6226112.00 | 149.18 | 39.54 | 0.00 | 106.88 | 334.24 |
| core-long-form / proposal.create | complete | 20 | 96.35 | 114.63 | 411.00 | 804.00 | 804.00 | 68.51 | 3012611.00 | 114.43 | 114.43 | 0.00 | 55.82 | 330.44 |
| core-long-form / proposal.approval | complete | 20 | 1.44 | 4.79 | 5.00 | 3.00 | 3.00 | 1.23 | 6317.00 | 4.72 | 4.72 | 0.00 | 0.49 | 332.32 |
| core-long-form / operation.apply.receipt | complete | 20 | 189.63 | 218.90 | 828.00 | 1623.00 | 1625.00 | 136.19 | 6062658.00 | 218.81 | 218.81 | 0.00 | 112.51 | 328.81 |
| core-long-form / application.receipt.replay | complete | 20 | 1.36 | 1.59 | 4.00 | 11.00 | 11.00 | 1.10 | 32166.00 | 1.52 | 1.52 | 0.00 | 0.57 | 330.56 |
| core-small / snapshot.materialize.cold | complete | 1 | 35.61 | 35.61 | 20.00 | 19.00 | 19.00 | 19.36 | 2371535.00 | 30.79 | 15.89 | 0.00 | 27.65 | 96.50 |
| core-small / snapshot.current.warm | complete | 20 | 15.54 | 18.51 | 18.00 | 18.00 | 18.00 | 8.35 | 2371486.00 | 17.66 | 0.00 | 0.00 | 14.80 | 135.15 |
| core-small / snapshot.scene.current | complete | 20 | 15.96 | 18.46 | 18.00 | 18.00 | 18.00 | 8.62 | 2371486.00 | 17.22 | 0.00 | 0.00 | 15.80 | 131.78 |
| core-small / snapshot.pinned.first | complete | 1 | 13.53 | 13.53 | 6.00 | 2.00 | 2.00 | 8.15 | 2375478.00 | 12.61 | 0.00 | 0.00 | 18.40 | 114.93 |
| core-small / snapshot.reader.pinned.first | complete | 1 | 12.62 | 12.62 | 6.00 | 2.00 | 2.00 | 7.73 | 2375478.00 | 12.26 | 0.00 | 0.00 | 8.79 | 119.68 |
| core-small / snapshot.pinned.warm | complete | 20 | 12.23 | 14.18 | 6.00 | 2.00 | 2.00 | 7.02 | 2375478.00 | 13.48 | 0.00 | 0.00 | 8.77 | 131.77 |
| core-small / snapshot.scene.pinned | complete | 20 | 12.59 | 14.70 | 6.00 | 2.00 | 2.00 | 7.42 | 2375478.00 | 13.22 | 0.00 | 0.00 | 9.97 | 125.62 |
| core-small / knowledge.evidence.projection | complete | 1 | 0.10 | 0.10 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.72 | 112.80 |
| core-small / tree.retrieve | complete | 1 | 12.22 | 12.22 | 6.00 | 2.00 | 2.00 | 6.91 | 2375478.00 | 11.29 | 0.00 | 0.00 | 8.87 | 117.80 |
| core-small / literal.search | complete | 20 | 14.93 | 17.62 | 18.00 | 18.00 | 18.00 | 7.56 | 2371486.00 | 16.18 | 0.00 | 0.00 | 11.27 | 118.52 |
| core-small / writing.statistics | complete | 20 | 26.57 | 32.21 | 18.00 | 18.00 | 18.00 | 7.85 | 2371486.00 | 17.05 | 0.00 | 0.00 | 25.16 | 165.36 |
| core-small / history.list | complete | 20 | 0.61 | 1.22 | 3.00 | 4.00 | 4.00 | 0.54 | 5827.00 | 1.12 | 0.00 | 0.00 | 0.25 | 175.35 |
| core-small / history.revision.bodies | complete | 20 | 1.08 | 1.34 | 6.00 | 4.00 | 4.00 | 0.98 | 5830.00 | 1.29 | 0.00 | 0.00 | 0.42 | 174.35 |
| core-small / document.save | complete | 20 | 2.78 | 3.08 | 12.00 | 6.00 | 8.00 | 2.48 | 5025.00 | 3.05 | 3.05 | 0.00 | 1.04 | 161.95 |
| core-small / mutation.snapshot.prepare | complete | 20 | 23.00 | 25.93 | 20.00 | 19.00 | 19.00 | 15.22 | 2372735.00 | 25.55 | 16.57 | 0.00 | 18.18 | 182.08 |
| core-small / proposal.create | complete | 20 | 11.86 | 12.78 | 19.00 | 20.00 | 20.00 | 7.84 | 1187246.00 | 12.64 | 12.64 | 0.00 | 15.68 | 168.92 |
| core-small / proposal.approval | complete | 20 | 1.44 | 3.59 | 5.00 | 3.00 | 3.00 | 1.28 | 5895.00 | 3.53 | 3.53 | 0.00 | 0.51 | 170.80 |
| core-small / operation.apply.receipt | complete | 20 | 21.30 | 23.54 | 44.00 | 55.00 | 57.00 | 13.57 | 2409390.00 | 23.46 | 23.46 | 0.00 | 22.08 | 170.10 |
| core-small / application.receipt.replay | complete | 20 | 1.56 | 4.29 | 4.00 | 11.00 | 11.00 | 1.26 | 30050.00 | 4.22 | 4.22 | 0.00 | 0.95 | 168.96 |

| Browser dataset / operation | Worker status | n | App p50 / p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | API CPU p50 ms | API RSS max MiB | Browser CPU p50 ms | Browser RSS max MiB |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| browser-long-form / browser.startup.login-ready | complete | 1 | 122.78 / 122.78 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 15.97 | 132.14 | 400.00 | 850.09 |
| browser-long-form / browser.author.login | complete | 1 | 102.81 / 102.81 | 4.00 | 5.00 | 5.00 | 785.00 | 1.26 | 0.00 | 0.00 | 10.09 | 132.27 | 180.00 | 871.84 |
| browser-long-form / browser.navigation.project-and-first-scene | complete | 1 | 383.06 / 383.06 | 887.00 | 2028.00 | 2028.00 | 9394106.00 | 279.03 | 53.87 | 0.00 | 341.95 | 179.88 | 650.00 | 971.75 |
| browser-long-form / browser.authoring.save-and-receipt | complete | 9 | 1379.36 / 3240.02 | 294.00 | 331.00 | 333.00 | 5947375.00 | 417.69 | 57.90 | 0.00 | 120.17 | 217.79 | 850.00 | 1918.40 |
| browser-long-form / browser.navigation.scene | complete | 2 | 309.42 / 317.74 | 715.00 | 1483.00 | 1483.00 | 12717340.00 | 338.47 | 40.23 | 0.00 | 239.10 | 221.27 | 430.00 | 1413.08 |
| browser-long-form / browser.navigation.repeat | complete | 20 | 272.11 / 321.35 | 796.00 | 1524.00 | 1524.00 | 12610495.00 | 415.43 | 0.00 | 0.00 | 180.83 | 292.61 | 380.00 | 1648.93 |
| browser-small / browser.startup.login-ready | complete | 1 | 122.30 / 122.30 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 16.09 | 104.17 | 410.00 | 853.77 |
| browser-small / browser.author.login | complete | 1 | 108.48 / 108.48 | 4.00 | 3.00 | 3.00 | 398.00 | 1.34 | 0.00 | 0.00 | 9.14 | 104.17 | 140.00 | 875.44 |
| browser-small / browser.navigation.project-and-first-scene | complete | 1 | 216.90 / 216.90 | 161.00 | 123.00 | 123.00 | 11870506.00 | 177.55 | 18.91 | 0.00 | 191.65 | 140.56 | 420.00 | 943.91 |
| browser-small / browser.authoring.save-and-receipt | complete | 9 | 1268.89 / 3236.61 | 19.00 | 16.00 | 18.00 | 212154.00 | 40.14 | 19.93 | 0.00 | 27.62 | 141.21 | 660.00 | 1962.35 |
| browser-small / browser.navigation.scene | complete | 2 | 148.99 / 163.27 | 44.00 | 30.00 | 30.00 | 5057175.00 | 55.94 | 0.00 | 0.00 | 57.35 | 139.49 | 190.00 | 1305.09 |
| browser-small / browser.navigation.repeat | complete | 20 | 125.50 / 166.02 | 55.00 | 42.00 | 42.00 | 5058271.00 | 61.24 | 0.00 | 0.00 | 59.90 | 173.82 | 180.00 | 1557.93 |

| Browser dataset / document bytes | typing frame n | p50 / p95 / p99 ms | strict IDB writes n / p95 ms | React commits | Long Tasks n / p95 ms |
| --- | ---: | --- | --- | ---: | --- |
| browser-long-form / 1315 | 30 | 10.60 / 15.40 / 16.20 | 31 / 255.40 | 37 | 0 / NOT_CHECKED |
| browser-long-form / 1315 | 30 | 10.00 / 16.10 / 18.80 | 31 / 208.60 | 37 | 0 / NOT_CHECKED |
| browser-long-form / 1315 | 30 | 9.90 / 16.70 / 17.60 | 31 / 209.90 | 37 | 0 / NOT_CHECKED |
| browser-long-form / 102400 | 30 | 10.00 / 21.80 / 23.00 | 31 / 384.10 | 37 | 0 / NOT_CHECKED |
| browser-long-form / 102400 | 30 | 10.30 / 20.00 / 20.30 | 31 / 399.50 | 37 | 0 / NOT_CHECKED |
| browser-long-form / 102400 | 30 | 10.00 / 19.30 / 20.40 | 31 / 355.70 | 37 | 0 / NOT_CHECKED |
| browser-long-form / 1048576 | 30 | 54.70 / 70.40 / 79.50 | 31 / 1829.00 | 38 | 30 / 69.00 |
| browser-long-form / 1048576 | 30 | 52.00 / 62.70 / 67.30 | 31 / 1648.00 | 41 | 26 / 62.00 |
| browser-long-form / 1048576 | 30 | 51.60 / 53.70 / 53.80 | 31 / 1558.80 | 41 | 25 / 53.00 |
| browser-small / 1111 | 30 | 8.50 / 14.60 / 17.30 | 31 / 131.20 | 36 | 0 / NOT_CHECKED |
| browser-small / 1111 | 30 | 9.20 / 15.40 / 15.90 | 31 / 123.00 | 37 | 0 / NOT_CHECKED |
| browser-small / 1111 | 30 | 8.80 / 16.30 / 16.50 | 31 / 114.60 | 36 | 0 / NOT_CHECKED |
| browser-small / 102400 | 30 | 9.30 / 18.40 / 19.20 | 31 / 286.40 | 36 | 0 / NOT_CHECKED |
| browser-small / 102400 | 30 | 9.00 / 17.90 / 18.10 | 31 / 329.70 | 36 | 0 / NOT_CHECKED |
| browser-small / 102400 | 30 | 9.40 / 16.80 / 17.10 | 31 / 264.70 | 36 | 0 / NOT_CHECKED |
| browser-small / 1048576 | 30 | 53.00 / 65.90 / 72.10 | 31 / 1705.90 | 40 | 25 / 65.00 |
| browser-small / 1048576 | 30 | 50.30 / 67.70 / 80.70 | 31 / 1581.40 | 45 | 13 / 80.00 |
| browser-small / 1048576 | 30 | 58.30 / 68.20 / 80.90 | 31 / 1701.90 | 45 | 18 / 80.00 |
