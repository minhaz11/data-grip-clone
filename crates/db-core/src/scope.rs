//! Which schemas a data source introspects (REQ-EXPL-02).

/// Selected schema names plus wildcard patterns (`*` any run, `?` one character). A schema is in
/// scope when it is named or matches a pattern; an empty scope means every schema.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SchemaScope {
    pub names: Vec<String>,
    pub patterns: Vec<String>,
}

impl SchemaScope {
    pub fn is_all(&self) -> bool {
        self.names.is_empty() && self.patterns.is_empty()
    }

    pub fn contains(&self, schema: &str) -> bool {
        self.is_all()
            || self.names.iter().any(|n| n == schema)
            || self.patterns.iter().any(|p| glob_matches(p, schema))
    }

    /// The patterns as SQL `LIKE` patterns (backslash escapes), for engines that filter in SQL.
    pub fn like_patterns(&self) -> Vec<String> {
        self.patterns.iter().map(|p| glob_to_like(p)).collect()
    }
}

fn glob_to_like(glob: &str) -> String {
    let mut out = String::with_capacity(glob.len() + 4);
    for c in glob.chars() {
        match c {
            '*' => out.push('%'),
            '?' => out.push('_'),
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}

fn glob_matches(glob: &str, text: &str) -> bool {
    let (g, t): (Vec<char>, Vec<char>) = (glob.chars().collect(), text.chars().collect());
    // Iterative wildcard match with backtracking to the last `*`.
    let (mut gi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        match g.get(gi) {
            Some('*') => {
                star = Some((gi, ti));
                gi += 1;
            }
            Some(&c) if c == '?' || c == t[ti] => {
                gi += 1;
                ti += 1;
            }
            _ => match star {
                Some((sg, st)) => {
                    gi = sg + 1;
                    ti = st + 1;
                    star = Some((sg, st + 1));
                }
                None => return false,
            },
        }
    }
    g[gi..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_scope_is_everything() {
        let all = SchemaScope::default();
        assert!(all.is_all() && all.contains("public") && all.contains("x"));
    }

    #[test]
    fn names_and_patterns_select_schemas() {
        let scope = SchemaScope {
            names: vec!["public".into()],
            patterns: vec!["app_*".into(), "t?".into()],
        };
        for yes in ["public", "app_", "app_orders", "t1"] {
            assert!(scope.contains(yes), "{yes}");
        }
        for no in ["Public", "app", "xapp_1", "t12", "shop"] {
            assert!(!scope.contains(no), "{no}");
        }
    }

    #[test]
    fn like_patterns_escape_sql_wildcards() {
        let scope = SchemaScope {
            names: vec![],
            patterns: vec!["a_b%*".into(), r"x\?".into()],
        };
        assert_eq!(scope.like_patterns(), [r"a\_b\%%", r"x\\_"]);
    }
}
