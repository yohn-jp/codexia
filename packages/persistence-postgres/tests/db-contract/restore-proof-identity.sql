SELECT json_build_object(
  'project_title', p.title,
  'document_id', d.id::text,
  'document_title', d.title,
  'head_revision_id', d.head_revision_id::text,
  'revision_id', r.id::text,
  'revision_markdown', r.markdown,
  'author_id', r.author_id,
  'owner_id', u.id,
  'owner_email', u.email
)::text
FROM public.project p
JOIN public.document d ON d.project_id=p.id
JOIN public.document_revision r ON r.project_id=d.project_id AND r.document_id=d.id AND r.id=d.head_revision_id
JOIN codexia_auth."user" u ON u.id=r.author_id
WHERE p.id=:'contract_project_id';
