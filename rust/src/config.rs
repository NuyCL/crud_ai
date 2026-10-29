//! Configuration from environment variables only (CONVENTIONS.md).

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    pub db_path: String,
    pub admin_key: String,
    pub client_key: String,
}

impl Config {
    /// Read `PORT` (default 8080), `DB_PATH` (default ./flags.db), `ADMIN_KEY` and `CLIENT_KEY` (both required).
    pub fn load(env: &HashMap<String, String>) -> Result<Config, String> {
        let get = |name: &str| env.get(name).map(String::as_str).filter(|v| !v.is_empty());
        let missing: Vec<&str> = ["ADMIN_KEY", "CLIENT_KEY"].into_iter().filter(|n| get(n).is_none()).collect();
        if !missing.is_empty() {
            return Err(format!("missing required environment variable(s): {}", missing.join(", ")));
        }
        let raw_port = get("PORT").unwrap_or("8080");
        // ASCII digits only: `u16::from_str` accepts a leading '+', which is not a port number
        let port = if raw_port.bytes().all(|c| c.is_ascii_digit()) {
            raw_port.parse::<u16>().ok().filter(|p| *p >= 1)
        } else {
            None
        };
        let port = port.ok_or_else(|| format!("PORT must be a number from 1 to 65535, got \"{raw_port}\""))?;
        Ok(Config {
            port,
            db_path: get("DB_PATH").unwrap_or("./flags.db").to_string(),
            admin_key: get("ADMIN_KEY").unwrap_or_default().to_string(),
            client_key: get("CLIENT_KEY").unwrap_or_default().to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
    }

    #[test]
    fn defaults_and_values() {
        let c = Config::load(&env(&[("ADMIN_KEY", "a"), ("CLIENT_KEY", "c")])).unwrap();
        assert_eq!(
            c,
            Config { port: 8080, db_path: "./flags.db".into(), admin_key: "a".into(), client_key: "c".into() }
        );
        let c =
            Config::load(&env(&[("ADMIN_KEY", "a"), ("CLIENT_KEY", "c"), ("PORT", "9000"), ("DB_PATH", "/tmp/x.db")]))
                .unwrap();
        assert_eq!((c.port, c.db_path.as_str()), (9000, "/tmp/x.db"));
    }

    #[test]
    fn both_keys_are_required() {
        for e in [
            env(&[]),
            env(&[("ADMIN_KEY", "a")]),
            env(&[("CLIENT_KEY", "c")]),
            env(&[("ADMIN_KEY", ""), ("CLIENT_KEY", "c")]),
        ] {
            assert!(Config::load(&e).unwrap_err().contains("KEY"));
        }
    }

    #[test]
    fn port_must_be_a_number_from_1_to_65535() {
        for port in ["0", "65536", "-1", "+80", "abc", "8080x", "\u{668}\u{660}", "1.5", "123456", " 80"] {
            let e = Config::load(&env(&[("ADMIN_KEY", "a"), ("CLIENT_KEY", "c"), ("PORT", port)])).unwrap_err();
            assert!(e.contains("PORT"), "{port}: {e}");
        }
    }
}
