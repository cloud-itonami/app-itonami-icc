(ns itonami.app.entry
  "OpenICC on the device (AWAI-3502). The actions call the repo's own
  openicc.* namespaces unchanged. Left out on purpose: `openicc.core/draft`
  (the Article 15(2) communication naming people), `openicc.tick` (moves
  findings outward) and the inga consensus plane. Nothing is published or sent;
  the examples are fictional."
  (:require [itonami.app.run :as run]
            [openicc.bot.defence :as defence]
            [openicc.bot.examiner :as examiner]
            [openicc.core :as core]
            [openicc.governor :as gov]
            [openicc.record :as rec]))

(defn- ->assertion
  "Accept either a built assertion or the raw {:claim :sources :cites :subject-kind}
  form, with sources as {:url :publisher :cid :retrieved-at} maps."
  [a]
  (if (:assertion/claim a)
    a
    (rec/assertion (update a :sources #(mapv rec/source %)))))

(defn- ->dossier [d]
  (update d :dossier/findings
          (fn [fs] (into {} (map (fn [[k f]] [k (update f :finding/assertions #(mapv ->assertion (or % [])))])) fs))))

(def ^:private example-source
  "{:url \"https://example.test/reuters\" :publisher \"reuters\" :cid \"bafy1\" :retrieved-at \"2026-08-22T00:00:00Z\"}")

(def ^:private example-dossier
  (str "{:dossier/situation-id :example-situation
 :dossier/crime :crimes-against-humanity
 :dossier/findings
 {:elements {:finding/verdict :affirmative :finding/crime :crimes-against-humanity
             :finding/cites [\"7\"]
             :finding/assertions
             [{:claim \"forces attacked the town of X on 2019-04-02\"
               :sources [" example-source "
                         {:url \"https://example.test/amnesty\" :publisher \"amnesty\" :retrieved-at \"2026-08-22T00:00:00Z\"}]
               :cites [\"7(1)\"] :subject-kind :state}]
             :finding/unaddressed [] :finding/rationale \"contextual elements established\"
             :inference/endpoint \"on-device\"}
  :jurisdiction {:finding/verdict :affirmative :finding/cites [\"11\" \"13(a)\"] :finding/assertions []
                 :finding/rationale \"territorial limb satisfied\" :inference/endpoint \"on-device\"}
  :admissibility {:finding/verdict :affirmative :finding/cites [\"17(1)(a)\"] :finding/assertions []
                  :finding/ranking? false :finding/rationale \"shielding indicium cited\" :inference/endpoint \"on-device\"}
  :interests {:finding/verdict :affirmative :finding/cites [\"53(1)(c)\"] :finding/assertions []
              :finding/rationale \"no reason to stand down\" :inference/endpoint \"on-device\"}}
 :dossier/rebuttal {:ran? true :refuted? false :grounds [] :scanned 1}
 :dossier/conduct-window {:from \"2019-04-02\" :state-entry-into-force \"2003-01-01\"}
 :dossier/lineage [\"bafy1\"]
 :dossier/at \"2026-08-22T00:00:00Z\"}"))

(run/register!
 {:name "gates" :label "憲章ゲートを見る"
  :help "governor が判定する 14 のゲートと、その規則です。入力は要りません。"
  :example ""
  :run (fn [_] (mapv #(select-keys % [:gate/id :gate/rule]) gov/gates))})

(run/register!
 {:name "intake" :label "情報を取り込む（examiner）"
  :help "主張と出典の一覧を、出典つきの assertion にします。出典のない主張や、不正な手段で集めた出典は退けます。"
  :example (str "{:items [{:claim \"forces attacked the town of X on 2019-04-02\"
          :sources [" example-source "]
          :cites [\"7(1)\"] :subject-kind :state}
         {:claim \"\" :sources []}]}")
  :run (fn [{:keys [items]}]
         (let [r (examiner/intake (mapv #(update % :sources (fn [ss] (mapv rec/source (or ss [])))) items))]
           (assoc r :seriousness (examiner/seriousness r))))})

(run/register!
 {:name "admit" :label "ゲートで判定する（governor）"
  :help "dossier を 14 のゲートで判定します。登録簿の条文が未確認（:unverified-seed）の間、G2 は必ず退けます。名指しの公表には 2f+1 の quorum 証明書が要り（G7）、この app は証明書を作りません。この app の判定は murakumo ではなく端末内（:inference/endpoint \"on-device\"）なので、G14 も退けます。"
  :example example-dossier
  :run (fn [d] (let [adm (gov/admit (->dossier d) (:dossier/at d))]
                 {:admitted? (:admitted? adm) :explain (gov/explain adm)
                  :refusals (mapv #(select-keys % [:gate/id :refusal/reason]) (:refusals adm))}))})

(run/register!
 {:name "defence" :label "反論する（defence）"
  :help "弁護 bot が dossier を崩しにいきます。名指しの主張に独立した出典が 2 つ未満なら、それを根拠に反論します。"
  :example example-dossier
  :run (fn [d] (defence/refute (->dossier d) {}))})

(run/register!
 {:name "status" :label "状況をまとめる"
  :help "dossier の判定・assertion の数・名指しの数・反論・ゲートの結果を 1 つにまとめます。"
  :example example-dossier
  :run (fn [d] (core/status (->dossier d)))})
