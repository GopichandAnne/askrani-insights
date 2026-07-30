-- Seed: starter restaurant canonical taxonomy (guide 7.3).
-- Embeddings are populated by the extraction worker (scripts/embed.ts) once
-- ANTHROPIC/OpenAI keys are present; names + aliases are enough to bootstrap
-- fuzzy (pg_trgm) linking on day one.

insert into canonical_entity (vertical, kind, name, aliases, attributes) values
  ('restaurant','dish','Chicken Tikka Masala', array['CTM','tikka masala'], '{"cuisine":"indian","dietary":["gluten_free_optional"]}'),
  ('restaurant','dish','Butter Chicken',       array['murgh makhani'],       '{"cuisine":"indian"}'),
  ('restaurant','dish','Margherita Pizza',     array['margarita pizza'],     '{"cuisine":"italian","dietary":["vegetarian"]}'),
  ('restaurant','dish','Chicken Biryani',      array['biriyani','biryani'],  '{"cuisine":"indian"}'),
  ('restaurant','dish','Pad Thai',             array['phad thai'],           '{"cuisine":"thai"}'),
  ('restaurant','dish','Cheeseburger',         array['burger'],              '{"cuisine":"american"}'),
  ('restaurant','dish','Caesar Salad',         array['ceasar salad'],        '{"cuisine":"american","dietary":["vegetarian_optional"]}'),
  ('restaurant','service','Catering Package',  array['catering'],            '{}'),
  ('restaurant','event','Happy Hour',          array['happyhour'],           '{"daypart":"evening"}'),
  ('restaurant','event','Weekend Brunch',      array['brunch'],              '{"daypart":"morning"}')
on conflict do nothing;

-- Starter grocery catalog (guide 7.2). Names + aliases bootstrap fuzzy linking.
insert into canonical_entity (vertical, kind, name, aliases, attributes) values
  ('grocery','product','Aashirvaad Atta',       array['aashirvaad chakki atta','whole wheat flour'], '{"brand":"Aashirvaad","category":"flour"}'),
  ('grocery','product','Basmati Rice',           array['basmati'],                     '{"category":"rice"}'),
  ('grocery','product','Toor Dal',               array['toor dhal','arhar dal'],       '{"category":"lentils"}'),
  ('grocery','product','Paneer',                 array['cottage cheese'],              '{"category":"dairy"}'),
  ('grocery','product','Maggi Noodles',          array['maggi'],                       '{"brand":"Nestlé","category":"instant"}'),
  ('grocery','product','Amul Butter',            array['amul'],                        '{"brand":"Amul","category":"dairy"}'),
  ('grocery','product','Mango Pulp',             array['kesar mango pulp'],            '{"category":"canned"}')
on conflict do nothing;
