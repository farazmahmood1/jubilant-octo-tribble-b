-- A parcel's sale and COGS follow its delivery history, not the moment the sync saw it: a parcel
-- delivered and later returned carries a sale and its reversal whether the sync saw it delivered
-- first or only after the return. Almost every parcel is delivered at most once; one that is
-- returned and delivered again has a second sale. `occurrence` says which delivery an entry
-- belongs to, so a re-run can tell "the first delivery's sale, already reversed" from "the
-- second delivery's sale, not yet posted". It is 1 for every other entry.
alter table journal_entries add column occurrence smallint not null default 1 check (occurrence >= 1);
