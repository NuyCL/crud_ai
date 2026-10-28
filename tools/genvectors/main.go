// genvectors writes the language-neutral test vectors in tests/vectors/.
//
// It is a bootstrap reference implementation of spec/evaluation.md. Every
// evaluation case states its intended reason up front; the generator fails if
// the computed result disagrees, so the vectors cannot silently drift from the
// spec. Re-run after any change to the spec:
//
//	cd tools/genvectors && go run . ../../tests/vectors
package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"strings"
)

// ---------------------------------------------------------------- hashing

func fnv1a32(s string) uint32 {
	h := uint32(2166136261)
	for _, b := range []byte(s) {
		h ^= uint32(b)
		h *= 16777619
	}
	return h
}

func bucket(flagKey, salt, userID string) uint32 {
	return fnv1a32(flagKey+":"+salt+":"+userID) % 10000
}

// ------------------------------------------------------------- evaluation

type Rule struct {
	Attribute string      `json:"attribute"`
	Operator  string      `json:"operator"`
	Value     interface{} `json:"value"`
}

type Variant struct {
	Key    string `json:"key"`
	Weight int    `json:"weight"`
}

type Flag struct {
	Key            string    `json:"key"`
	Enabled        bool      `json:"enabled"`
	Rules          []Rule    `json:"rules"`
	RolloutPercent int       `json:"rolloutPercent"`
	Variants       []Variant `json:"variants"`
}

type Context struct {
	UserID     string                 `json:"userId,omitempty"`
	Attributes map[string]interface{} `json:"attributes,omitempty"`
}

type Result struct {
	Enabled bool    `json:"enabled"`
	Variant *string `json:"variant"`
	Reason  string  `json:"reason"`
}

func scalarEq(a, b interface{}) bool {
	norm := func(v interface{}) interface{} {
		if n, ok := v.(int); ok {
			return float64(n)
		}
		return v
	}
	return norm(a) == norm(b)
}

func ruleMatches(r Rule, attrs map[string]interface{}) bool {
	got, ok := attrs[r.Attribute]
	if !ok {
		return false
	}
	switch r.Operator {
	case "eq":
		return scalarEq(got, r.Value)
	case "neq":
		return !scalarEq(got, r.Value)
	case "in", "not_in":
		found := false
		for _, v := range r.Value.([]interface{}) {
			if scalarEq(got, v) {
				found = true
				break
			}
		}
		return found == (r.Operator == "in")
	}
	panic("unknown operator " + r.Operator)
}

func evaluate(f *Flag, ctx Context) Result {
	off := func(reason string) Result { return Result{false, nil, reason} }
	if f == nil {
		return off("FLAG_NOT_FOUND")
	}
	if !f.Enabled {
		return off("DISABLED")
	}
	for _, r := range f.Rules {
		if !ruleMatches(r, ctx.Attributes) {
			return off("TARGETING_MISS")
		}
	}
	needsBucket := f.RolloutPercent < 100 || len(f.Variants) > 0
	if needsBucket && ctx.UserID == "" {
		return off("MISSING_USER_ID")
	}
	if f.RolloutPercent < 100 && int(bucket(f.Key, "rollout", ctx.UserID)) >= f.RolloutPercent*100 {
		return off("NOT_IN_ROLLOUT")
	}
	if len(f.Variants) == 0 {
		return Result{true, nil, "ON"}
	}
	b := int(bucket(f.Key, "variant", ctx.UserID))
	threshold := 0
	for _, v := range f.Variants {
		threshold += v.Weight * 100
		if b < threshold {
			k := v.Key
			return Result{true, &k, "VARIANT"}
		}
	}
	panic("variant weights do not sum to 100")
}

// --------------------------------------------------------------- user search

// findUser returns the first "<prefix>-<n>" whose bucket(flagKey, salt) equals want.
func findUser(prefix, flagKey, salt string, want uint32) string {
	for n := 0; n < 5_000_000; n++ {
		u := fmt.Sprintf("%s-%d", prefix, n)
		if bucket(flagKey, salt, u) == want {
			return u
		}
	}
	panic(fmt.Sprintf("no user for %s/%s/%d", flagKey, salt, want))
}

// ------------------------------------------------------------------- output

func writeJSON(dir, name string, v interface{}) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), append(data, '\n'), 0o644); err != nil {
		panic(err)
	}
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: genvectors <output-dir>")
		os.Exit(2)
	}
	dir := os.Args[1]
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	genFNV(dir)
	genBucketing(dir)
	genEvaluation(dir)
}

// ------------------------------------------------------------- fnv1a32.json

func genFNV(dir string) {
	type row struct {
		Input string `json:"input"`
		Hash  uint32 `json:"hash"`
		Hex   string `json:"hex"`
	}
	inputs := []string{"", "a", "b", "foobar", "hello", "feature-flag", "ผู้ใช้", "café", "日本語", "😀", strings.Repeat("x", 200)}
	var rows []row
	for _, in := range inputs {
		h := fnv1a32(in)
		std := fnv.New32a()
		std.Write([]byte(in))
		if std.Sum32() != h {
			panic("fnv1a32 disagrees with hash/fnv for " + in)
		}
		rows = append(rows, row{in, h, fmt.Sprintf("0x%08x", h)})
	}
	writeJSON(dir, "fnv1a32.json", map[string]interface{}{
		"description": "FNV-1a 32-bit over the UTF-8 bytes of input. First rows are the published reference values.",
		"cases":       rows,
	})
}

// ---------------------------------------------------------- bucketing.json

func genBucketing(dir string) {
	type row struct {
		FlagKey string `json:"flagKey"`
		Salt    string `json:"salt"`
		UserID  string `json:"userId"`
		Input   string `json:"input"`
		Hash    uint32 `json:"hash"`
		Bucket  uint32 `json:"bucket"`
	}
	flags := []string{"new-checkout", "checkout-button", "dark-mode", "beta_search", "a"}
	users := []string{"alice", "bob", "user@example.com", "ผู้ใช้-1", "café", "日本語", "😀", "a:b", "550e8400-e29b-41d4-a716-446655440000", strings.Repeat("u", 200)}
	for i := 1; i <= 20; i++ {
		users = append(users, fmt.Sprintf("u%d", i))
	}
	var rows []row
	for _, f := range flags {
		for _, salt := range []string{"rollout", "variant"} {
			for _, u := range users {
				in := f + ":" + salt + ":" + u
				h := fnv1a32(in)
				rows = append(rows, row{f, salt, u, in, h, h % 10000})
			}
		}
	}
	writeJSON(dir, "bucketing.json", map[string]interface{}{
		"description": "bucket = fnv1a32(flagKey + ':' + salt + ':' + userId) mod 10000. Every implementation must reproduce hash and bucket for every row.",
		"cases":       rows,
	})
}

// ------------------------------------------------------- evaluation.json

type evalCase struct {
	ID          string      `json:"id"`
	Description string      `json:"description"`
	FlagKey     string      `json:"flagKey"`
	Flag        *Flag       `json:"flag"`
	Context     Context     `json:"context"`
	Expected    Result      `json:"expected"`
	Debug       interface{} `json:"debug,omitempty"`
}

func genEvaluation(dir string) {
	var cases []evalCase
	add := func(id, desc string, flag *Flag, flagKey string, ctx Context, wantReason string, wantVariant string) {
		res := evaluate(flag, ctx)
		wantEnabled := wantReason == "ON" || wantReason == "VARIANT"
		gotVariant := ""
		if res.Variant != nil {
			gotVariant = *res.Variant
		}
		if res.Reason != wantReason || res.Enabled != wantEnabled || gotVariant != wantVariant {
			panic(fmt.Sprintf("case %s: intended %s/%q, computed %+v", id, wantReason, wantVariant, res))
		}
		c := evalCase{ID: id, Description: desc, FlagKey: flagKey, Flag: flag, Context: ctx, Expected: res}
		if flag != nil && ctx.UserID != "" {
			d := map[string]uint32{}
			if flag.RolloutPercent < 100 {
				d["rolloutBucket"] = bucket(flag.Key, "rollout", ctx.UserID)
			}
			if len(flag.Variants) > 0 {
				d["variantBucket"] = bucket(flag.Key, "variant", ctx.UserID)
			}
			if len(d) > 0 {
				c.Debug = d
			}
		}
		cases = append(cases, c)
	}
	mk := func(key string, enabled bool, rules []Rule, rollout int, variants []Variant) *Flag {
		if rules == nil {
			rules = []Rule{}
		}
		if variants == nil {
			variants = []Variant{}
		}
		return &Flag{Key: key, Enabled: enabled, Rules: rules, RolloutPercent: rollout, Variants: variants}
	}
	attrs := func(kv ...interface{}) map[string]interface{} {
		m := map[string]interface{}{}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}
	arr := func(v ...interface{}) []interface{} { return v }

	// ---- basics (MVP1)
	add("basic-not-found", "flag does not exist", nil, "ghost-flag", Context{UserID: "u1"}, "FLAG_NOT_FOUND", "")
	add("basic-disabled", "enabled=false", mk("f", false, nil, 100, nil), "f", Context{UserID: "u1"}, "DISABLED", "")
	add("basic-on", "enabled boolean flag with user", mk("f", true, nil, 100, nil), "f", Context{UserID: "u1"}, "ON", "")
	add("basic-on-no-user", "enabled boolean flag needs no userId at 100% rollout", mk("f", true, nil, 100, nil), "f", Context{}, "ON", "")

	// ---- targeting
	ukRule := func(op string, v interface{}) []Rule { return []Rule{{"country", op, v}} }
	add("target-eq-pass", "eq matches", mk("f", true, ukRule("eq", "TH"), 100, nil), "f", Context{Attributes: attrs("country", "TH")}, "ON", "")
	add("target-eq-fail", "eq differs", mk("f", true, ukRule("eq", "TH"), 100, nil), "f", Context{Attributes: attrs("country", "US")}, "TARGETING_MISS", "")
	add("target-eq-missing", "eq on missing attribute fails", mk("f", true, ukRule("eq", "TH"), 100, nil), "f", Context{UserID: "u1"}, "TARGETING_MISS", "")
	add("target-eq-case", "string comparison is case-sensitive", mk("f", true, ukRule("eq", "TH"), 100, nil), "f", Context{Attributes: attrs("country", "th")}, "TARGETING_MISS", "")
	add("target-eq-type-string-vs-number", `"1" does not equal 1`, mk("f", true, []Rule{{"level", "eq", 1}}, 100, nil), "f", Context{Attributes: attrs("level", "1")}, "TARGETING_MISS", "")
	add("target-eq-number", "number equals number", mk("f", true, []Rule{{"age", "eq", 18}}, 100, nil), "f", Context{Attributes: attrs("age", 18)}, "ON", "")
	add("target-eq-bool", "bool equals bool", mk("f", true, []Rule{{"beta", "eq", true}}, 100, nil), "f", Context{Attributes: attrs("beta", true)}, "ON", "")
	add("target-eq-bool-vs-string", `true does not equal "true"`, mk("f", true, []Rule{{"beta", "eq", true}}, 100, nil), "f", Context{Attributes: attrs("beta", "true")}, "TARGETING_MISS", "")
	add("target-neq-pass", "neq differs", mk("f", true, ukRule("neq", "TH"), 100, nil), "f", Context{Attributes: attrs("country", "US")}, "ON", "")
	add("target-neq-fail", "neq equal", mk("f", true, ukRule("neq", "TH"), 100, nil), "f", Context{Attributes: attrs("country", "TH")}, "TARGETING_MISS", "")
	add("target-neq-missing", "neq on missing attribute fails", mk("f", true, ukRule("neq", "TH"), 100, nil), "f", Context{UserID: "u1"}, "TARGETING_MISS", "")
	add("target-in-pass", "in contains", mk("f", true, ukRule("in", arr("TH", "SG")), 100, nil), "f", Context{Attributes: attrs("country", "SG")}, "ON", "")
	add("target-in-fail", "in does not contain", mk("f", true, ukRule("in", arr("TH", "SG")), 100, nil), "f", Context{Attributes: attrs("country", "US")}, "TARGETING_MISS", "")
	add("target-in-numbers", "in with numbers", mk("f", true, []Rule{{"tier", "in", arr(1, 2, 3)}}, 100, nil), "f", Context{Attributes: attrs("tier", 2)}, "ON", "")
	add("target-not-in-pass", "not_in does not contain", mk("f", true, ukRule("not_in", arr("TH", "SG")), 100, nil), "f", Context{Attributes: attrs("country", "US")}, "ON", "")
	add("target-not-in-fail", "not_in contains", mk("f", true, ukRule("not_in", arr("TH", "SG")), 100, nil), "f", Context{Attributes: attrs("country", "TH")}, "TARGETING_MISS", "")
	add("target-not-in-missing", "not_in on missing attribute fails", mk("f", true, ukRule("not_in", arr("TH")), 100, nil), "f", Context{UserID: "u1"}, "TARGETING_MISS", "")
	both := []Rule{{"country", "eq", "TH"}, {"plan", "in", arr("pro", "team")}}
	add("target-and-both-pass", "all rules must pass: both do", mk("f", true, both, 100, nil), "f", Context{Attributes: attrs("country", "TH", "plan", "pro")}, "ON", "")
	add("target-and-one-fails", "all rules must pass: second fails", mk("f", true, both, 100, nil), "f", Context{Attributes: attrs("country", "TH", "plan", "free")}, "TARGETING_MISS", "")
	// Attribute names that collide with members of JavaScript's Object.prototype. A port that
	// looks attributes up with `attrs[name]` or `name in attrs` finds a function that is not there.
	for _, name := range []string{"constructor", "toString", "__proto__"} {
		add("target-attr-"+name+"-missing", "attribute named '"+name+"' that the context does not contain counts as missing (neq fails too)",
			mk("f", true, []Rule{{name, "neq", "x"}}, 100, nil), "f", Context{UserID: "u1", Attributes: attrs("country", "TH")}, "TARGETING_MISS", "")
	}
	add("target-attr-not-in-tostring-missing", "not_in on a missing attribute named 'toString' fails",
		mk("f", true, []Rule{{"toString", "not_in", arr("x")}}, 100, nil), "f", Context{Attributes: attrs("country", "TH")}, "TARGETING_MISS", "")
	add("target-attr-proto-present", "an attribute literally named '__proto__' is compared like any other",
		mk("f", true, []Rule{{"__proto__", "eq", "x"}}, 100, nil), "f", Context{Attributes: attrs("__proto__", "x")}, "ON", "")
	add("target-attr-constructor-present", "an attribute literally named 'constructor' is compared like any other",
		mk("f", true, []Rule{{"constructor", "in", arr("a", "b")}}, 100, nil), "f", Context{Attributes: attrs("constructor", "b")}, "ON", "")
	add("target-userid-is-not-attribute", "userId cannot be targeted as an attribute", mk("f", true, []Rule{{"userId", "eq", "u1"}}, 100, nil), "f", Context{UserID: "u1"}, "TARGETING_MISS", "")
	add("target-disabled-wins", "DISABLED is reported before targeting", mk("f", false, ukRule("eq", "TH"), 100, nil), "f", Context{Attributes: attrs("country", "US")}, "DISABLED", "")

	// ---- rollout
	r10 := mk("rollout-flag", true, nil, 10, nil)
	add("rollout-no-user", "rollout<100 needs userId", r10, "rollout-flag", Context{}, "MISSING_USER_ID", "")
	add("rollout-100-skips-bucketing", "rollout=100 never looks at the hash", mk("rollout-flag", true, nil, 100, nil), "rollout-flag", Context{}, "ON", "")
	add("rollout-0-nobody", "rollout=0 excludes everyone", mk("rollout-flag", true, nil, 0, nil), "rollout-flag", Context{UserID: "alice"}, "NOT_IN_ROLLOUT", "")
	add("rollout-0-no-user", "rollout=0 without userId still reports MISSING_USER_ID", mk("rollout-flag", true, nil, 0, nil), "rollout-flag", Context{}, "MISSING_USER_ID", "")
	add("rollout-10-in-low", "bucket 0 is inside 10%", r10, "rollout-flag", Context{UserID: findUser("lo", "rollout-flag", "rollout", 0)}, "ON", "")
	add("rollout-10-boundary-in", "bucket 999 is the last bucket inside 10%", r10, "rollout-flag", Context{UserID: findUser("edge", "rollout-flag", "rollout", 999)}, "ON", "")
	add("rollout-10-boundary-out", "bucket 1000 is the first bucket outside 10%", r10, "rollout-flag", Context{UserID: findUser("edge", "rollout-flag", "rollout", 1000)}, "NOT_IN_ROLLOUT", "")
	add("rollout-10-out-high", "bucket 9999 is outside 10%", r10, "rollout-flag", Context{UserID: findUser("hi", "rollout-flag", "rollout", 9999)}, "NOT_IN_ROLLOUT", "")
	add("rollout-99-boundary-in", "bucket 9899 inside 99%", mk("rollout-flag", true, nil, 99, nil), "rollout-flag", Context{UserID: findUser("e99", "rollout-flag", "rollout", 9899)}, "ON", "")
	add("rollout-99-boundary-out", "bucket 9900 outside 99%", mk("rollout-flag", true, nil, 99, nil), "rollout-flag", Context{UserID: findUser("e99", "rollout-flag", "rollout", 9900)}, "NOT_IN_ROLLOUT", "")
	add("rollout-targeting-miss-no-user", "targeting runs before the userId check", mk("rollout-flag", true, ukRule("eq", "TH"), 10, nil), "rollout-flag", Context{Attributes: attrs("country", "US")}, "TARGETING_MISS", "")
	add("rollout-unicode-user", "non-ASCII userId is accepted and bucketed (hash correctness is checked in bucketing.json)", mk("rollout-flag", true, nil, 50, nil), "rollout-flag", Context{UserID: "ผู้ใช้-1"}, "NOT_IN_ROLLOUT", "")

	// ---- variants
	abc := []Variant{{"blue", 50}, {"green", 30}, {"red", 20}}
	vf := mk("checkout-button", true, nil, 100, abc)
	vcase := func(id, desc string, b uint32, want string) {
		add(id, desc, vf, "checkout-button", Context{UserID: findUser("v", "checkout-button", "variant", b)}, "VARIANT", want)
	}
	vcase("variant-bucket-0", "first bucket belongs to the first variant", 0, "blue")
	vcase("variant-bucket-4999", "last bucket of blue", 4999, "blue")
	vcase("variant-bucket-5000", "first bucket of green", 5000, "green")
	vcase("variant-bucket-7999", "last bucket of green", 7999, "green")
	vcase("variant-bucket-8000", "first bucket of red", 8000, "red")
	vcase("variant-bucket-9999", "last bucket belongs to the last variant", 9999, "red")
	add("variant-no-user", "variants need userId", vf, "checkout-button", Context{}, "MISSING_USER_ID", "")
	add("variant-disabled", "disabled flag has no variant", mk("checkout-button", false, nil, 100, abc), "checkout-button", Context{UserID: "alice"}, "DISABLED", "")

	// variant order matters: the same user lands in a different variant when order is swapped
	ordUser := ""
	for n := 0; ; n++ {
		u := fmt.Sprintf("ord-%d", n)
		if b := bucket("order-flag", "variant", u); b < 5000 {
			ordUser = u
			break
		}
	}
	add("variant-order-a", "bucket<5000 with [a 50, b 50] picks a", mk("order-flag", true, nil, 100, []Variant{{"a", 50}, {"b", 50}}), "order-flag", Context{UserID: ordUser}, "VARIANT", "a")
	add("variant-order-b", "same user with [b 50, a 50] picks b: declared order decides", mk("order-flag", true, nil, 100, []Variant{{"b", 50}, {"a", 50}}), "order-flag", Context{UserID: ordUser}, "VARIANT", "b")

	// rollout + variants use independent salts
	rv := mk("rv-flag", true, nil, 50, []Variant{{"control", 50}, {"treatment", 50}})
	var rvIn, rvOut string
	for n := 0; rvIn == "" || rvOut == ""; n++ {
		u := fmt.Sprintf("rv-%d", n)
		if bucket("rv-flag", "rollout", u) < 5000 {
			if rvIn == "" && bucket("rv-flag", "variant", u) >= 5000 {
				rvIn = u
			}
		} else if rvOut == "" {
			rvOut = u
		}
	}
	add("variant-with-rollout-in", "in rollout, variant chosen by the variant salt (not the rollout bucket)", rv, "rv-flag", Context{UserID: rvIn}, "VARIANT", "treatment")
	add("variant-with-rollout-out", "outside rollout: no variant", rv, "rv-flag", Context{UserID: rvOut}, "NOT_IN_ROLLOUT", "")
	add("variant-targeting-first", "targeting runs before userId check", mk("checkout-button", true, ukRule("eq", "TH"), 100, abc), "checkout-button", Context{Attributes: attrs("country", "US")}, "TARGETING_MISS", "")
	add("variant-unicode-user", "non-ASCII userId", vf, "checkout-button", Context{UserID: "日本語"}, "VARIANT", func() string {
		return *evaluate(vf, Context{UserID: "日本語"}).Variant
	}())

	writeJSON(dir, "evaluation.json", map[string]interface{}{
		"description": "Each case: evaluate `flag` (null = flag absent) for `context`; result must equal `expected` exactly. `debug` is informational (bucket values).",
		"cases":       cases,
	})
	fmt.Printf("wrote %d evaluation cases\n", len(cases))
}
