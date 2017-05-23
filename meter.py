# -*- coding: utf-8 -*-
import sys
sys.path.append('./xlrd/')
import os
import xlrd

def excel_meter(xlr, outdir):
    if not os.path.isdir(outdir):
        os.mkdir(outdir)

    data = xlrd.open_workbook(xlr)
    tables = data.sheets()

    for i in xrange(len(tables)):
        file_name = tables[i].name

        meta_name = tables[i].name
        elem = []
        for n in xrange(tables[i].ncols):
            elem.append((tables[i].cell(0,n).value, tables[i].cell(1,n).value))

        table_name = tables[i].name + 's'

        code = "/*this caller file is codegen by meter for c#*/\n"
        code += "using System;\n"
        code += "using System.Collections.Generic;\n\n"

        code += "namespace meter\n"
        code += "{\n"
        code += "   public class " + meta_name + "\n"
        code += "   {\n"
        for k, v in elem:
            code += "       public " + v + " " + k + ";\n"
        code += "\n       public " + meta_name + "("
        for j in xrange(len(elem)):
            k,v = elem[j]
            if j < (len(elem) - 1):
                code += " " + v + " _" + k + ","
            else:
                code += " " + v + " _" + k + " "
        code += ")\n"
        code += "       {\n"
        for k, v in elem:
            code += "           " + k + " = _" + k + ";\n"
        code += "       }\n"
        code += "   }\n\n"
        code += "   public class " + table_name + "\n"
        code += "   {\n"
        code += "       public List<" + meta_name + "> tables;\n\n"
        code += "       public " + table_name + "()\n"
        code += "       {\n"
        code += "           tables = new List<" + meta_name + ">{\n"
        for n in xrange(2, tables[i].nrows):
            code += "               new " + meta_name + "("
            for m in xrange(tables[i].ncols):
                k,v = elem[m]
                if v == "string":
                    code += " \"" + str(tables[i].cell(n,m).value) + "\""
                if v == "int":
                    code += " " + str(int(tables[i].cell(n,m).value))
                if v == "bool":
                    code += " " + str(tables[i].cell(n,m).value)
                if v == "float":
                    code += " (float)" + str(tables[i].cell(n,m).value)
                if m < (tables[i].ncols - 1):
                    code += ","
                else:
                    code += " "
            if n < (tables[i].nrows - 1):
                code += "),\n"
            else:
                code += ")\n"
        code += "           };\n"
        code += "       }\n\n"
        code += "       static private " + table_name + " instance;\n"
        code += "       static public " + table_name + " GetInstance()\n"
        code += "       {\n"
        code += "           if (instance == null)\n"
        code += "           {\n"
        code += "               instance = new " + table_name + "();\n"
        code += "           }\n"
        code += "           return instance;\n"
        code += "       }\n"      
        code += "   }\n"
        code += "}\n"

        file = open(outdir + '//' + file_name + '.cs', 'w')
        file.write(code)
        file.close

if __name__=="__main__":
    excel_meter(sys.argv[1], sys.argv[2])
