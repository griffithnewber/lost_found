本目录文件逐字节取自 git 提交 cc9e40de76bc6736d89e17e78ecd0cf877b5ade7 的 assets/ 目录：

  assets/search.js  文字检索算法（LF.search.text）
  assets/match.js   分级与 label（LF.match.annotate）
  assets/ui.js      categoryMeta / toneMeta（label 字典的取法）
  assets/config.js  类别与主色调字典

用途：tests/sql/lf_search_parity.test.mjs 把这份历史实现当作基准，
与 db/migrations/2026-11-07_lf_search_text_v1.sql 的 SQL 实现逐条对照。
不要修改这些文件——它们是迁移的参照物，改了就失去对照意义。
