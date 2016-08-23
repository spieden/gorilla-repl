(ns gorilla-repl.s3
  "Utility functions to help with scanning for and loading gorilla files."
  (:require [clojure.string :as str]
            [amazonica.aws.s3 :as s3]
            [clojure.java.io :as io]))

(defn get-bucket []
  (get (System/getenv) "WORKSHEET_BUCKET"))

(defn put-worksheet [worksheet content]
  (let [text-bytes (.getBytes content "utf-8")
        text-in    (io/input-stream text-bytes)]
    (s3/put-object :bucket-name (get-bucket)
                   :key worksheet
                   :metadata {:content-type   (str "application/edn; charset=utf8")
                              :content-length (count text-bytes)}
                   :input-stream text-in)))

(defn list-worksheets []
  (->> (s3/list-objects (get-bucket) "")
       :object-summaries
       (into [] (map :key))))

(defn get-worksheet [worksheet]
  (-> (s3/get-object (get-bucket) worksheet)
      :input-stream
      (slurp :encoding "UTF-8")))

