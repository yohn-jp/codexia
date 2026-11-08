// Complete PostgreSQL-only verification inventory. Both browser engines are required.
export const VERIFICATION_LEAF_JOBS = ['plan', 'unit', 'types', 'build', 'browser-chromium', 'browser-webkit', 'oci'];
export const REQUIRED_VERIFICATION_JOBS = [...VERIFICATION_LEAF_JOBS, 'certification'];
