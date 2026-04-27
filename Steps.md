# Steps

## Step 0

- Devise an internal core model, program flow, IR.
- implement the most basic characteristics
- generate virtual subsets (not actual Sets) with functional appartenance and complement against *S* methods

flow:

types: typestrings, IR

1. multiples algorithm produce subsets and their implementation in IR
2. agregate all competing implementation per subset
3. cost function to compare two IR programs (simplicity and performance)
4. for each available subset, choose lowest cost function
5. output metrics : %age of subsets provided, list of missing ones

accept arbitrary string list (not typestring-hardcoded)
every subset can also provide its own complement
