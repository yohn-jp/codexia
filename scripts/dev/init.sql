-- The official PostgreSQL entrypoint creates codexia_test before this file.
-- Each additional database is for a separate, disposable verification path.
CREATE DATABASE codexia_auth_test;
CREATE DATABASE codexia_e2e_compat_cloud;
CREATE DATABASE codexia_web_oauth_test;
