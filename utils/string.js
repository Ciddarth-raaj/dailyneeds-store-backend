const stringUtil = {};

stringUtil.capitalizeWords = (str) => {
  return str
    .split(" ") // split string into words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" "); // join back to string
};

module.exports = stringUtil;
